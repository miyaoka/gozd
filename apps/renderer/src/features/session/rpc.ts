// Claude セッションの RPC wrapper。
import type { ClaudeSessionListRequest, ClaudeSessionListResponse } from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

// repo（本体と全 worktree）で動いたセッションの一覧。SSOT は Claude Code のセッションログ。
export const rpcClaudeSessionList = (req: ClaudeSessionListRequest) =>
  rpc<ClaudeSessionListResponse>("/claudeSession/list", req);
