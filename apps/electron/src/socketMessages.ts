// SocketServer から届く NDJSON 1 行（ClientMessage）の解釈と配送。
//
// 処理順序の保証: 同 ptyId の session-start / session-end / 次の session-start は
// submit 順に処理されなければならない。node は単一スレッドだが await 境界で別メッセージが
// 割り込めるため、promise chain の逐次キューで順序を作る。
//
// キューに載せるのは順序に意味がある種別だけ。worktree の作成は hook と順序関係を持たず
// 実行が長いため、キューの外で走らせる（載せると作成中の状態通知が全 PTY で止まる）。

import type { ClientMessage, ClientReply, HookMessage, NewWorktreeMessage } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { basename } from "node:path";
import { resolveAndCreateWorktree, toWorktreeEntry } from "./git/worktreeCreate";
import { buildGozdOpenPayload } from "./openTarget";
import { asDict, lenientBoolean, lenientDict, lenientNumber, lenientString } from "./rawJson";
import type { SocketMessageHandler } from "./socketServer";
import { clearSessionId, setSessionId, wasExplicitlyRemoved, worktreePathFor } from "./ptySessions";
import type { PushFn } from "./rpcDispatcher";

/** session-start / session-end hook を PTY ⇔ session の紐付けに反映する */
function applyClaudeSessionHook(hook: HookMessage, worktreePath: string): void {
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

  // /clear や --resume で同 ptyId のセッションが切り替わっても、session-start は上書きで反映する
  // （Claude は旧セッションの session-end を発火しない）
  if (hook.event === "session-start") {
    setSessionId(hook.ptyId, hook.sessionId);
    return;
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
      prompt: lenientString(newWorktree.prompt, "newWorktree.prompt"),
    };
  }
  return msg;
}

/** `gozd worktree new` を処理して ClientReply の 1 行を返す。
 * worktree 作成までを main が完了させ、UI 反映（サイドバー掲載 / claude の autostart）は
 * push に委ねる。応答は「作成できたか」だけを表し、push が届いたかは含まない —
 * renderer が居ない状態でも worktree は正しく作られる。 */
async function handleNewWorktree(msg: NewWorktreeMessage, push: PushFn): Promise<string> {
  const reply = (value: ClientReply): string => JSON.stringify(value);
  if (msg.dir === "") {
    return reply({ ok: false, dir: "", error: "newWorktree: dir is required" });
  }
  const created = await tryCatch(
    resolveAndCreateWorktree({ dir: msg.dir, branch: "", startPoint: "" }),
  );
  if (!created.ok) {
    console.error(
      `[handleNewWorktree] resolveAndCreateWorktree failed: ${created.error} dir=${msg.dir}`,
    );
    return reply({ ok: false, dir: "", error: String(created.error) });
  }
  const { rootDir, info, setupScript } = created.value;
  push("newWorktree", {
    rootDir,
    worktree: toWorktreeEntry(info),
    dir: info.path,
    setupScript,
    prompt: msg.prompt,
    repoName: basename(rootDir),
  });
  return reply({ ok: true, dir: info.path, error: "" });
}

/** 逐次キューに載せる種別の処理。応答は返さない。 */
async function handleQueuedMessage(msg: ClientMessage, push: PushFn): Promise<undefined> {
  if (msg.hook !== undefined) {
    const hook = msg.hook;
    if (hook.event === "session-start" || hook.event === "session-end") {
      applyClaudeSessionHook(hook, worktreePathFor(hook.ptyId));
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
