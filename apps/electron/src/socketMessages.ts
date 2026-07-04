// SocketServer から届く NDJSON 1 行（ClientMessage）の解釈と配送。
// Swift 版 `RpcDispatcher.handleSocketMessage` + `RpcDispatcher+ClaudeSession.swift` の
// `applyClaudeSessionHook` の対応物。
//
// 処理順序の保証: Swift は actor 逐次化で「同 ptyId の session-start / session-end /
// 次の session-start」が submit 順に処理されることを保証する。node は単一スレッドだが
// await 境界で別メッセージが割り込めるため、promise chain の逐次キューで同じ保証を作る。
// session 系 hook は頻度が低く、後続 push を待たせる影響は小さい。

import { ClientMessage, type HookMessage } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { buildGozdOpenPayload } from "./openTarget";
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
  console.error(`[TaskStore] ${message}: ${error}`);
  push("notify", { type: "error", source: "task-store", message, detail: String(error), dir });
}

/** session-start / session-end hook を task store に反映する。
 * 各 taskStore 呼び出しは個別 tryCatch で notify に倒すため、本関数自身は throw しない */
async function applyClaudeSessionHook(hook: HookMessage, worktreePath: string, push: PushFn): Promise<void> {
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
      console.error(`[applyClaudeSessionHook] ${hook.event} for unknown pty=${hook.ptyId}; skipping`);
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
        notifyTaskStoreError(push, "Failed to detach previous session from task", detached.error, worktreePath);
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
    const attached = await tryCatch(taskStore.attachSession(worktreePath, hook.sessionId, worktreePath));
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

async function handleSocketMessage(line: string, push: PushFn): Promise<void> {
  const parsed = tryCatch(() => ClientMessage.fromJSON(JSON.parse(line)));
  if (!parsed.ok) {
    console.error(`[SocketServer] failed to decode ClientMessage: ${parsed.error}: ${line.slice(0, 200)}`);
    return;
  }
  const msg = parsed.value;
  if (msg.hook !== undefined) {
    const hook = msg.hook;
    if (hook.event === "session-start" || hook.event === "session-end") {
      await applyClaudeSessionHook(hook, worktreePathFor(hook.ptyId), push);
    }
    // Swift onHook と同形の payload（renderer useTerminalStore handleHookEvent 契約）
    push("hook", {
      event: hook.event,
      ptyId: hook.ptyId,
      sessionId: hook.sessionId,
      lastAssistantMessage: hook.lastAssistantMessage,
      toolName: hook.toolName,
      toolInput: hook.toolInput,
      pendingWork: hook.pendingWork,
    });
    return;
  }
  if (msg.open !== undefined) {
    push("gozdOpen", await buildGozdOpenPayload(msg.open.targetPath));
    return;
  }
  console.error(`[SocketServer] ClientMessage with empty oneof: ${line.slice(0, 200)}`);
}

/** socket 1 行を逐次処理するハンドラを作る。promise chain で submit 順の処理を保証する */
export function createSocketMessageHandler(push: PushFn): (line: string) => void {
  let chain: Promise<void> = Promise.resolve();
  return (line) => {
    chain = chain.then(() => handleSocketMessage(line, push));
  };
}
