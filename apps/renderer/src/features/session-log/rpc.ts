// session-log feature が使う RPC wrapper。
//
// session log の実体は worktree 外 (`~/.claude/projects/<encoded>/<sessionId>.jsonl`) に
// 置かれるため、本 feature は load (`rpcClaudeSessionLog`) と watch を組み合わせて
// dialog / terminal preview にライブログを供給する。watch 自体は filer feature の汎用
// `rpcFsWatch` / `rpcFsUnwatch` を借りる (`useSessionLogLive` 参照)。
import { ClaudeSessionLogRequest, ClaudeSessionLogResponse } from "@gozd/proto";

import { rpc } from "../../shared/rpc";

// task ⋮ メニューの「Show session log」と terminal preview の両方が起点になる。
// session_id (UUID) を渡すと native が ~/.claude/projects/*/<session_id>.jsonl を
// glob 解決して、 main + subagent の生 JSONL 一式を返す。
export const rpcClaudeSessionLog = (req: ClaudeSessionLogRequest) =>
  rpc("/claudeSession/readLog", req, ClaudeSessionLogRequest, ClaudeSessionLogResponse);
