import Foundation
import GozdProto

// Claude session 紐付け系。SocketServer 経由の `session-start` / `session-end` hook を
// task store に反映する `applyClaudeSessionHook` と、pane close 時の cleanup を担う
// `handleClaudeSessionRemoveByPty`、log 読み出し `handleClaudeSessionReadLog` を扱う。
//
// 設計の核: task ≠ Claude session。session は task に attach する短命属性で、pane close /
// SessionEnd hook で detach されても task 本体は残り、`closed_by_user=true` で表示状態だけ
// 切り替える。明示削除はユーザーの ⋮ メニューを待つ。

extension RpcDispatcher {
  /// session-start / session-end hook を task store に反映する。`handleSocketMessage` から
  /// 呼ばれる。actor 内で逐次化されるため hook の順序は SocketServer の submit 順を保つ。
  /// 各 `tasks.*` 呼び出しは個別 do/catch で notify に倒すため、本関数自身は throw しない。
  func applyClaudeSessionHook(
    _ hook: Gozd_V1_HookMessage, worktreePath: String
  ) async {
    guard !hook.sessionID.isEmpty else { return }
    if worktreePath.isEmpty {
      // worktreePath 空には 2 つの異なる経路がある。観察ログで区別する:
      // (a) 削除 RPC で clearAssociations 済み → 「Claude 起動直後の closePane」で
      //     生じる late hook を構造的に弾いた正常パス。skip と明記する。
      // (b) そもそも未登録 ptyId → spawn 経路の不整合、調査対象。error と明記する。
      if await pty.wasExplicitlyRemoved(hook.ptyID) {
        StderrLog.write(
          tag: "applyClaudeSessionHook",
          "late \(hook.event) for pty=\(hook.ptyID) session=\(hook.sessionID) after removeByPty; skipping"
        )
      } else {
        StderrLog.write(
          tag: "applyClaudeSessionHook",
          "\(hook.event) for unknown pty=\(hook.ptyID); skipping"
        )
      }
      return
    }
    // session の永続化は task.session_id (TaskStore) が SSOT。各 tasks 呼び出しは
    // 個別 do/catch で notify に倒すため、この関数は throw せず素の switch で書く。
    switch hook.event {
    case "session-start":
      // 同 ptyId で前回観測した sessionId と異なるなら、PTY 内で `/clear` や
      // `--resume` でセッションが切り替わったケース。Claude は旧セッションの
      // session-end を発火しないため、旧 session を持っていた Task から sessionID を
      // 切り離す (task 本体は残し、新 session 開始経路 attachSession の「sessionID 空 +
      // 同 worktree」候補に回す)。ptyId スコープに限るので別 leaf の生きたセッションは
      // 触らない。直近 sessionId は PTYRegistry に保持し、unregisterPane 経由の削除 RPC
      // （/claudeSession/removeByPty）からも同じマッピングを参照する。
      if let previous = await pty.sessionId(for: hook.ptyID),
        previous != hook.sessionID
      {
        do {
          try await tasks.detachSession(dir: worktreePath, sessionId: previous)
        } catch {
          StderrLog.write(tag: "TaskStore", "detachSession (previous) failed: \(error)")
          onNotify(
            "error", "task-store", "Failed to detach previous session from task",
            String(describing: error), worktreePath)
        }
      }
      // expected resume sid を必ず消費する。これで removeByPty 経路の
      // 「expected 残存 = SessionStart 不達 = resume 失敗」判定が意味的に閉じる。
      // 返り値が hook.sessionID と一致 → resume 成功 (no-op、attachSession が冪等処理)。
      // 不一致かつ非空 → `claude --resume X` が失敗して zsh が素の `claude` に
      // fallback したケース。dead expected を tasks から掃除して、後段 attachSession(Y)
      // が「sessionID 空の最新 task」を再 attach できる候補にするため道を空ける
      // (clearDeadSession で X 持ち task の sessionID が空に書き戻されることで
      // attachSession の候補ピックアップに乗る。元 task の id に固定指定しているわけ
      // ではないので、同 worktree に他 sessionID 空 task があれば createdAt 最新の方が
      // 拾われる)。pane close を待たずに新 sid で復活させるため attachSession(Y) の前段で実行。
      let expectedSid = (await pty.consumeExpectedResumeSid(for: hook.ptyID)) ?? ""
      if !expectedSid.isEmpty && expectedSid != hook.sessionID {
        do {
          // session-start fallback 経路: `closed_by_user` は据え置き
          // (markClosedByUser=false)。直後の `attachSession(hook.sessionID)` が
          // sessionID 空の同 worktree task を candidate ピックで自動転移する。
          // ここで closed_by_user=true を立ててもピック対象から外れることは無いが、
          // ユーザーは pane を閉じていないので semantic 的にも false 据え置きが正しい。
          try await tasks.clearDeadSession(
            dir: worktreePath, sessionId: expectedSid, markClosedByUser: false)
        } catch {
          StderrLog.write(
            tag: "TaskStore",
            "clearDeadSession (session-start fallback) failed: \(error)"
          )
          onNotify(
            "error", "task-store",
            "Failed to clear dead session from task after resume failure (fallback)",
            String(describing: error), worktreePath)
        }
      }
      // SessionStart hook: 該当 worktree で sessionID 空の最新 task に attach。無ければ
      // 新規 task を作る (PR/issue picker を経ない Claude 直接起動経路)。永続化
      // (attachSession) を先に成功させてから PTYRegistry のマッピングを更新する。逆順
      // だと attachSession が throw した場合 PTYRegistry だけ新 sessionId に進み、次回
      // cleanup (removeByPty) の根拠 (永続化と同期した sessionId) を失う。
      do {
        try await tasks.attachSession(
          dir: worktreePath,
          sessionId: hook.sessionID,
          worktreeDir: worktreePath
        )
        await pty.setSessionId(for: hook.ptyID, sessionId: hook.sessionID)
      } catch {
        StderrLog.write(tag: "TaskStore", "attachSession failed: \(error)")
        onNotify(
          "error", "task-store", "Failed to attach session to task",
          String(describing: error), worktreePath)
      }
    case "session-end":
      // SessionEnd: task.sessionID は保持して `claude --resume` の起点に使う。
      // task 本体は削除せず、`closed_by_user=true` を立ててサイドバー表示を
      // `closed` 状態に切り替える。明示的削除はユーザーの ⋮ メニューで行う。
      // 永続化 (detachSession) を先に成功させてから PTYRegistry のマッピングを消す。
      do {
        try await tasks.detachSession(dir: worktreePath, sessionId: hook.sessionID)
      } catch {
        StderrLog.write(tag: "TaskStore", "detachSession failed: \(error)")
        onNotify(
          "error", "task-store", "Failed to detach session from task",
          String(describing: error), worktreePath)
      }
      await pty.clearSessionId(for: hook.ptyID)
    default:
      // 呼び出し元 handleSocketMessage が hook.event を session-start /
      // session-end に絞り込んでから呼ぶため到達しない。silent break で将来フィルタが
      // 緩んだとき no-op にならないよう preconditionFailure で観察可能化する。
      preconditionFailure(
        "applyClaudeSessionHook reached with unexpected event: \(hook.event)")
    }
  }

  func handleClaudeSessionReadLog(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ClaudeSessionLogRequest(jsonUTF8Data: body)
    let result = ClaudeSessionLog.read(sessionId: req.sessionID)
    var resp = Gozd_V1_ClaudeSessionLogResponse()
    resp.found = result.found
    resp.entries = result.entries.map { entry in
      var e = Gozd_V1_ClaudeSessionLogEntry()
      e.kind = entry.kind
      e.id = entry.id
      e.label = entry.label
      e.agentType = entry.agentType
      e.path = entry.path
      e.content = entry.content
      e.parentToolUseID = entry.parentToolUseId
      e.name = entry.name
      e.workflowRunID = entry.workflowRunId
      e.workflowName = entry.workflowName
      e.phaseTitle = entry.phaseTitle
      return e
    }
    return try resp.jsonUTF8Data()
  }

  func handleClaudeSessionRemoveByPty(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_ClaudeSessionRemoveByPtyRequest(jsonUTF8Data: body)
    // sessionId / worktreePath 紐付けは最後に **必ず** クリアする (後置の
    // clearAssociations)。tasks 側の cleanup が throw しても late session-start hook を
    // 弾く必要があるため、各 tasks 呼び出しは個別 do/catch に閉じて throw を伝播させない。
    // これにより「Claude 起動直後の closePane」で発生しうる race を構造的に防ぐ。
    var removedSessionId = ""

    // expected resume sid は SessionStart 経路 (applyClaudeSessionHook) で一度
    // 着弾した時点で必ず consumeExpectedResumeSid されるため、removeByPty 到達時点で
    // 残っているのは「SessionStart hook が一度も着弾していない」ケースに限られる。
    // - 一致 (resume 成功): consume 後の上書きで normal attach
    // - 不一致 (zsh fallback で新 sid 起動): consume + dead expected cleanup を session-start 内で完結
    // - 不達 (zsh fallback も失敗 / ユーザーが素シェルのまま pane 閉鎖): expected 残存
    let liveSid = (await pty.sessionId(for: req.ptyID)) ?? ""
    let expectedSid = (await pty.consumeExpectedResumeSid(for: req.ptyID)) ?? ""

    // SessionStart 着弾時点で expected を必ず消費するので、removeByPty 時点で
    // 「expected と live が同居」は構造的に発生し得ない (SessionStart 着弾 = expected
    // 消費 = removeByPty では nil)。precondition で契約を明示し、到達したら fatal で
    // 気付ける形にする。
    precondition(
      expectedSid.isEmpty || liveSid.isEmpty,
      "expectedSid (\(expectedSid)) and liveSid (\(liveSid)) both non-empty; SessionStart consume invariant broken"
    )

    if !expectedSid.isEmpty {
      // SessionStart hook が一度も着弾しないまま pane が閉じられた。
      // `claude --resume <sid>` が transcript 不在等で error 終了し、zsh fallback の
      // 素 `claude` も SessionStart 不達のまま終わった (起動エラー / ユーザーが即 /exit)
      // 等のケース。clearDeadSession で task の sessionID を空に書き換え + closed_by_user=true。
      // task 本体は残り、次のクリックで `--resume` ではなく素の claude 起動に流す。
      // ユーザーの明示削除 (⋮ メニュー) を待つまで closed 状態で滞留する。
      do {
        // removeByPty 経路 (terminal close + resume 失敗): pane が閉じているので
        // 直後の attachSession は走らない。ユーザーが pane を閉じた事実をシグナル化
        // するため markClosedByUser=true。サイドバー上は `closed` 状態として残る。
        try await tasks.clearDeadSession(
          dir: req.worktreePath, sessionId: expectedSid, markClosedByUser: true)
      } catch {
        StderrLog.write(tag: "TaskStore", "clearDeadSession failed: \(error)")
        onNotify(
          "error", "task-store",
          "Failed to clear dead session from task after resume failure",
          String(describing: error), req.worktreePath)
      }
    }

    // live session cleanup。ターミナル close は session-end hook を発火させないため、
    // ここで明示的に detachSession を呼び `closed_by_user=true` を立てる。task 本体と
    // sessionID は保持されるので、サイドバー上は `closed` 状態として残り、明示削除は
    // ユーザーの ⋮ メニュー or worktree 削除 cascade を待つ。
    if !liveSid.isEmpty {
      removedSessionId = liveSid
      // detachSession 失敗を放置すると stale な sessionID が残るので notify する。
      do {
        try await tasks.detachSession(dir: req.worktreePath, sessionId: liveSid)
      } catch {
        StderrLog.write(
          tag: "TaskStore", "detachSession (removeByPty) failed: \(error)")
        onNotify(
          "error", "task-store", "Failed to detach session on terminal close",
          String(describing: error), req.worktreePath)
      }
    } else if !expectedSid.isEmpty {
      // live なし + expected あり (純粋な resume 失敗)。removedSessionId に expected を
      // 載せて renderer に「何かは消した」と伝える。renderer 側はこの値を見て
      // lastRemovedSessionInfo を更新し、所属 repo を refetch する。
      removedSessionId = expectedSid
    }
    // else: live も expected もない素 PTY pane (claude を一度も起動しなかった) の close。
    // 正常経路でログ価値が薄いため stderr には残さない。removedSessionId は空のままで、
    // renderer 側は sessionId 空をトリガに refetch を skip する契約。

    await pty.clearAssociations(for: req.ptyID)
    var resp = Gozd_V1_ClaudeSessionRemoveByPtyResponse()
    resp.removedSessionID = removedSessionId
    return try resp.jsonUTF8Data()
  }
}
