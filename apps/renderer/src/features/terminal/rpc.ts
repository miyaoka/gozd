// terminal feature が使う RPC wrapper と push event payload 型。
import {
  ClaudeSessionRemoveByPtyRequest,
  ClaudeSessionRemoveByPtyResponse,
  OpenExternalRequest,
  OpenExternalResponse,
  PtyKillRequest,
  PtyKillResponse,
  PtyResizeRequest,
  PtyResizeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
  ResumableSessionListRequest,
  ResumableSessionListResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

// --- request ---

export const rpcPtySpawn = (req: PtySpawnRequest) =>
  rpc("/pty/spawn", req, PtySpawnRequest, PtySpawnResponse);

// dir で resume 可能な Claude セッションの session_id 一覧を取得する。SSOT は
// tasks.json (task.session_id)。visit() が未訪問 worktree の初回オープン時に呼ぶ。
export const rpcResumableSessionList = (req: ResumableSessionListRequest) =>
  rpc("/task/resumableSessions", req, ResumableSessionListRequest, ResumableSessionListResponse);

export const rpcClaudeSessionRemoveByPty = (req: ClaudeSessionRemoveByPtyRequest) =>
  rpc(
    "/claudeSession/removeByPty",
    req,
    ClaudeSessionRemoveByPtyRequest,
    ClaudeSessionRemoveByPtyResponse,
  );

export const rpcPtyWrite = (req: PtyWriteRequest) =>
  rpc("/pty/write", req, PtyWriteRequest, PtyWriteResponse);

export const rpcPtyResize = (req: PtyResizeRequest) =>
  rpc("/pty/resize", req, PtyResizeRequest, PtyResizeResponse);

export const rpcPtyKill = (req: PtyKillRequest) =>
  rpc("/pty/kill", req, PtyKillRequest, PtyKillResponse);

export const rpcOpenExternal = (req: OpenExternalRequest) =>
  rpc("/open/external", req, OpenExternalRequest, OpenExternalResponse);

// --- push event payload ---

export interface PtyTextPayload {
  id: number;
  text: string;
}

interface PtyExitReason {
  kind: "exited" | "signaled" | "stopped";
  exitCode?: number;
  signal?: number;
  coreDumped?: boolean;
}

export interface PtyExitPayload {
  id: number;
  reason: PtyExitReason;
}

export interface HookPayload {
  event: string;
  ptyId: number;
  /** Claude session ID。session-start / session-end で必ず入る。それ以外は空文字 */
  sessionId: string;
  lastAssistantMessage: string;
  toolName: string;
  toolInput: string;
  isInterrupt: boolean;
}
