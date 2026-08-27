// SocketServer から届く NDJSON 1 行（ClientMessage）の解釈と配送。
// Swift 版 `RpcDispatcher.handleSocketMessage` + `RpcDispatcher+ClaudeSession.swift` の
// `applyClaudeSessionHook` の対応物。
//
// 処理順序の保証: Swift は actor 逐次化で「同 ptyId の session-start / session-end /
// 次の session-start」が submit 順に処理されることを保証する。node は単一スレッドだが
// await 境界で別メッセージが割り込めるため、promise chain の逐次キューで同じ保証を作る。
// session 系 hook は頻度が低く、後続 push を待たせる影響は小さい。
//
// キューに載せるのは順序に意味がある種別だけ。worktree の作成は hook と順序関係を持たず
// 実行が長いため、キューの外で走らせる（載せると作成中の状態通知が全 PTY で止まる）。

import type { ClientMessage, ClientReply, HookMessage, NewWorktreeMessage } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { basename } from "node:path";
import { createTaskWorktree } from "./git/worktreeCreate";
import { buildGozdOpenPayload } from "./openTarget";
import {
  asDict,
  lenientBoolean,
  lenientDict,
  lenientGhRef,
  lenientNumber,
  lenientString,
} from "./rawJson";
import type { SocketMessageHandler } from "./socketServer";
import {
  clearSessionId,
  consumeExpectedResumeSid,
  sessionIdFor,
  setSessionId,
  wasExplicitlyRemoved,
  worktreePathFor,
} from "./ptySessions";
import type { PushFn } from "./rpcDispatcher";
import { taskStore } from "./taskStore";

function notifyTaskStoreError(push: PushFn, message: string, error: unknown, dir: string): void {
  console.error(`[TaskStore] ${message}: ${String(error)}`);
  push("notify", {
    type: "error",
    source: "task-store",
    message,
    detail: String(error),
    dir,
  });
}

/** session-start / session-end hook を task store に反映する。
 * 各 taskStore 呼び出しは個別 tryCatch で notify に倒すため、本関数自身は throw しない */
async function applyClaudeSessionHook(
  hook: HookMessage,
  worktreePath: string,
  push: PushFn,
): Promise<void> {
  if (hook.sessionId === "") return;
  if (worktreePath === "") {
    // worktreePath 空には 2 つの異なる経路がある。観察ログで区別する:
    // (a) 削除 RPC で clearAssociations 済み → 「Claude 起動直後の closePane」で生じる
    //     late hook を構造的に弾いた正常パス
    // (b) そもそも未登録 ptyId → spawn 経路の不整合、調査対象
    if (wasExplicitlyRemoved(hook.ptyId)) {
      console.error(
        `[applyClaudeSessionHook] late ${hook.event} for pty=${hook.ptyId} session=${hook.sessionId} after removeByPty; skipping`,
      );
    } else {
      console.error(
        `[applyClaudeSessionHook] ${hook.event} for unknown pty=${hook.ptyId}; skipping`,
      );
    }
    return;
  }

  if (hook.event === "session-start") {
    // 同 ptyId で前回観測した sessionId と異なるなら、PTY 内で /clear や --resume で
    // セッションが切り替わったケース。Claude は旧セッションの session-end を発火しない
    // ため、旧 session を持つ task から detach する（task 本体は残し、attachSession の
    // 「sessionID 空 + 同 worktree」候補に回す）
    const previous = sessionIdFor(hook.ptyId);
    if (previous !== "" && previous !== hook.sessionId) {
      const detached = await tryCatch(taskStore.detachSession(worktreePath, previous));
      if (!detached.ok) {
        notifyTaskStoreError(
          push,
          "Failed to detach previous session from task",
          detached.error,
          worktreePath,
        );
      }
    }
    // expected resume sid を必ず消費する。これで removeByPty 経路の
    // 「expected 残存 = SessionStart 不達 = resume 失敗」判定が意味的に閉じる。
    // 不一致かつ非空 = `claude --resume X` が失敗して zsh が素の claude に fallback した
    // ケース。dead expected を掃除して後段 attachSession(Y) の候補ピックに道を空ける
    const expectedSid = consumeExpectedResumeSid(hook.ptyId);
    if (expectedSid !== "" && expectedSid !== hook.sessionId) {
      // session-start fallback 経路: closedByUser は据え置き（markClosedByUser=false）。
      // ユーザーは pane を閉じていないので semantic 的にも false 据え置きが正しい
      const cleared = await tryCatch(taskStore.clearDeadSession(worktreePath, expectedSid, false));
      if (!cleared.ok) {
        notifyTaskStoreError(
          push,
          "Failed to clear dead session from task after resume failure (fallback)",
          cleared.error,
          worktreePath,
        );
      }
    }
    // 永続化（attachSession）を先に成功させてから registry のマッピングを更新する。
    // 逆順だと attach が失敗した場合 registry だけ新 sessionId に進み、次回 cleanup
    // （removeByPty）の根拠を失う
    const attached = await tryCatch(
      taskStore.attachSession(worktreePath, hook.sessionId, worktreePath),
    );
    if (attached.ok) {
      setSessionId(hook.ptyId, hook.sessionId);
    } else {
      notifyTaskStoreError(push, "Failed to attach session to task", attached.error, worktreePath);
    }
    return;
  }

  // session-end: task.sessionId は保持して `claude --resume` の起点に使う。
  // closedByUser=true でサイドバー表示を closed に切り替える
  const detached = await tryCatch(taskStore.detachSession(worktreePath, hook.sessionId));
  if (!detached.ok) {
    notifyTaskStoreError(push, "Failed to detach session from task", detached.error, worktreePath);
  }
  clearSessionId(hook.ptyId);
}

/** NDJSON 1 行を ClientMessage に正規化する。nc 直送経路の hook は event / ptyId しか
 * JSON に載せないため default 充填が必須（充填しないと hook push payload に undefined が
 * 混ざり、renderer 側の `sessionId !== ""` 等の文字列比較が壊れる）。
 * 型違反フィールドは lenient に default へ倒して stderr ログを残す（rawJson.ts の契約）。
 * hook は落とすと UI 状態が永続的にずれる push なので message ごと破棄しない */
function parseClientMessage(line: string): ClientMessage {
  const dict = asDict(JSON.parse(line));
  const msg: ClientMessage = {};
  if (dict.hook !== undefined) {
    const hook = lenientDict(dict.hook, "hook");
    msg.hook = {
      event: lenientString(hook.event, "hook.event"),
      ptyId: lenientNumber(hook.ptyId, "hook.ptyId"),
      lastAssistantMessage: lenientString(hook.lastAssistantMessage, "hook.lastAssistantMessage"),
      toolName: lenientString(hook.toolName, "hook.toolName"),
      toolInput: lenientString(hook.toolInput, "hook.toolInput"),
      sessionId: lenientString(hook.sessionId, "hook.sessionId"),
      pendingWork: lenientBoolean(hook.pendingWork, "hook.pendingWork"),
      hasTeammateTask: lenientBoolean(hook.hasTeammateTask, "hook.hasTeammateTask"),
      agentId: lenientString(hook.agentId, "hook.agentId"),
      teammateName: lenientString(hook.teammateName, "hook.teammateName"),
      source: lenientString(hook.source, "hook.source"),
    };
  }
  if (dict.open !== undefined) {
    msg.open = {
      targetPath: lenientString(lenientDict(dict.open, "open").targetPath, "open.targetPath"),
    };
  }
  if (dict.newWorktree !== undefined) {
    const newWorktree = lenientDict(dict.newWorktree, "newWorktree");
    msg.newWorktree = {
      dir: lenientString(newWorktree.dir, "newWorktree.dir"),
      title: lenientString(newWorktree.title, "newWorktree.title"),
      prompt: lenientString(newWorktree.prompt, "newWorktree.prompt"),
      ghRef: lenientGhRef(newWorktree.ghRef, "newWorktree.ghRef"),
    };
  }
  return msg;
}

/** `gozd worktree new` を処理して ClientReply の 1 行を返す。
 * worktree 作成と task 紐づけまでを main が完了させ、UI 反映（サイドバー掲載 /
 * claude の autostart）は push に委ねる。応答は「作成できたか」だけを表し、
 * push が届いたかは含まない — renderer が居ない状態でも worktree は正しく作られる。 */
async function handleNewWorktree(msg: NewWorktreeMessage, push: PushFn): Promise<string> {
  const reply = (value: ClientReply): string => JSON.stringify(value);
  if (msg.dir === "") {
    return reply({ ok: false, dir: "", error: "newWorktree: dir is required" });
  }
  // タイトル必須は CLI だけでなくここでも守る。socket は gozd が書いたと保証できない入力で、
  // CLI を経由しない送信でも「見分けの付かない Task」を作らせない
  if (msg.title === "") {
    return reply({ ok: false, dir: "", error: "newWorktree: title is required" });
  }
  const created = await tryCatch(
    createTaskWorktree({
      dir: msg.dir,
      branch: "",
      startPoint: "",
      ghTitle: msg.title,
      ghRef: msg.ghRef,
    }),
  );
  if (!created.ok) {
    console.error(`[handleNewWorktree] createTaskWorktree failed: ${created.error} dir=${msg.dir}`);
    return reply({ ok: false, dir: "", error: String(created.error) });
  }
  push("newWorktree", {
    ...created.value,
    prompt: msg.prompt,
    repoName: basename(created.value.rootDir),
  });
  return reply({ ok: true, dir: created.value.dir, error: "" });
}

/** 逐次キューに載せる種別の処理。応答は返さない。 */
async function handleQueuedMessage(msg: ClientMessage, push: PushFn): Promise<undefined> {
  if (msg.hook !== undefined) {
    const hook = msg.hook;
    if (hook.event === "session-start" || hook.event === "session-end") {
      await applyClaudeSessionHook(hook, worktreePathFor(hook.ptyId), push);
    }
    // source は socket 側の経路情報なので renderer には渡さない。
    // hook は parseClientMessage が field 単位に構築した値なので余剰キーは載らない
    // (パーサを cast に変えると、この rest spread が socket の任意キーを素通しする)
    const { source: _source, ...hookPayload } = hook;
    push("hook", hookPayload);
    return undefined;
  }
  if (msg.open !== undefined) {
    // undefined = 不在パス（buildGozdOpenPayload が観察ログを出して弾く）。push しない
    const payload = await buildGozdOpenPayload(msg.open.targetPath);
    if (payload !== undefined) push("gozdOpen", payload);
    return undefined;
  }
  console.error(
    `[SocketServer] ClientMessage with empty oneof: ${JSON.stringify(msg).slice(0, 200)}`,
  );
  return undefined;
}

/** socket 1 行を処理するハンドラを作る。
 *
 * 状態通知は promise chain の逐次キューに載せ、submit 順の処理を保証する。
 * **worktree の作成はこのキューに載せない** — git の実行で秒単位かかるうえ hook と順序
 * 関係を持たないため、載せると作成中は全 PTY の状態通知が止まる。 */
export function createSocketMessageHandler(push: PushFn): SocketMessageHandler {
  let chain: Promise<undefined> = Promise.resolve(undefined);
  // メッセージ単位の失敗を終端で握らないと chain が rejected のまま残り、以降の
  // 全メッセージが onRejected 不在の .then で素通しされて恒久 drop になる
  // （unhandledRejection になるだけで [SocketServer] の観察ログも出ない）。
  // キューを生かし続け、失敗行だけを観察ログに倒す
  const observeFailure = (line: string) => (error: unknown) => {
    console.error(
      `[SocketServer] handler rejected, chain kept alive: ${String(error)}: ${line.slice(0, 200)}`,
    );
    return undefined;
  };
  return (line) => {
    const parsed = tryCatch(() => parseClientMessage(line));
    if (!parsed.ok) {
      console.error(
        `[SocketServer] failed to decode ClientMessage: ${parsed.error}: ${line.slice(0, 200)}`,
      );
      return Promise.resolve(undefined);
    }
    const { newWorktree } = parsed.value;
    if (newWorktree !== undefined) {
      return handleNewWorktree(newWorktree, push).catch(observeFailure(line));
    }
    const settled = chain
      .then(() => handleQueuedMessage(parsed.value, push))
      .catch(observeFailure(line));
    chain = settled;
    return settled;
  };
}
