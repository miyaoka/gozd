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
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

// --- request ---

export const rpcPtySpawn = (req: PtySpawnRequest) => rpc<PtySpawnResponse>("/pty/spawn", req);

export const rpcClaudeSessionRemoveByPty = (req: ClaudeSessionRemoveByPtyRequest) =>
  rpc<ClaudeSessionRemoveByPtyResponse>("/claudeSession/removeByPty", req);

export const rpcPtyWrite = (req: PtyWriteRequest) => rpc<PtyWriteResponse>("/pty/write", req);

export const rpcPtyResize = (req: PtyResizeRequest) => rpc<PtyResizeResponse>("/pty/resize", req);

export const rpcPtyKill = (req: PtyKillRequest) => rpc<PtyKillResponse>("/pty/kill", req);

export const rpcOpenExternal = (req: OpenExternalRequest) =>
  rpc<OpenExternalResponse>("/open/external", req);

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
  /**
   * done (Stop) のみ。Stop 発火時に background_tasks / session_crons が残っているか。
   * true のとき主エージェントのターンは終わったが裏で作業継続中（再起動する）= 真の done ではない。
   */
  pendingWork: boolean;
}
