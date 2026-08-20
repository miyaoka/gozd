// terminal feature が使う RPC wrapper と push event payload 型。
import {
  ClaudeSessionRemoveByPtyRequest,
  ClaudeSessionRemoveByPtyResponse,
  FsExistsAbsoluteRequest,
  FsExistsAbsoluteResponse,
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

export const rpcFsExistsAbsolute = (req: FsExistsAbsoluteRequest) =>
  rpc<FsExistsAbsoluteResponse>("/fs/existsAbsolute", req);
