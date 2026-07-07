import {
  ReviveSessionListRequest,
  ReviveSessionListResponse,
  ReviveSessionRequest,
  ReviveSessionResponse,
} from "@gozd/rpc";

import { rpc } from "../../../../shared/rpc";

// この repo 配下の削除済み worktree に紐づく復活可能セッション一覧（~/.claude/projects 実走査）。
export const rpcReviveSessionList = (req: ReviveSessionListRequest) =>
  rpc<ReviveSessionListResponse>("/claudeSession/reviveList", req);

// セッション 1 件を worktree + sessionId 付き task として作り直す。以降は既存 resume 機構
// （visit 時の resumableSessions → `claude --resume`）が resume を駆動する。
export const rpcReviveSession = (req: ReviveSessionRequest) =>
  rpc<ReviveSessionResponse>("/claudeSession/revive", req);
