// 各 RPC の typed wrapper。`rpc()` ヘルパー + `@gozd/proto` の codec を組み合わせる。
//
// 新しい RPC を追加するときはここに 1 関数追加し、`shared/rpc/index.ts` から re-export する。

import {
  AppState,
  EchoRequest,
  EchoResponse,
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileRequest,
  FsReadFileResponse,
  GitStatusRequest,
  GitStatusResponse,
  LoadAppStateRequest,
  LoadAppStateResponse,
  PtyKillRequest,
  PtyKillResponse,
  PtyResizeRequest,
  PtyResizeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
} from "@gozd/proto";

import { rpc } from "./client";

export const rpcEcho = (req: EchoRequest) => rpc("/echo", req, EchoRequest, EchoResponse);

export const rpcGitStatus = (req: GitStatusRequest) =>
  rpc("/git/status", req, GitStatusRequest, GitStatusResponse);

export const rpcFsReadFile = (req: FsReadFileRequest) =>
  rpc("/fs/readFile", req, FsReadFileRequest, FsReadFileResponse);

export const rpcFsReadDir = (req: FsReadDirRequest) =>
  rpc("/fs/readDir", req, FsReadDirRequest, FsReadDirResponse);

export const rpcPtySpawn = (req: PtySpawnRequest) =>
  rpc("/pty/spawn", req, PtySpawnRequest, PtySpawnResponse);

export const rpcPtyWrite = (req: PtyWriteRequest) =>
  rpc("/pty/write", req, PtyWriteRequest, PtyWriteResponse);

export const rpcPtyResize = (req: PtyResizeRequest) =>
  rpc("/pty/resize", req, PtyResizeRequest, PtyResizeResponse);

export const rpcPtyKill = (req: PtyKillRequest) =>
  rpc("/pty/kill", req, PtyKillRequest, PtyKillResponse);

export const rpcLoadAppState = (req: LoadAppStateRequest = LoadAppStateRequest.create()) =>
  rpc("/appState/load", req, LoadAppStateRequest, LoadAppStateResponse);

export const rpcSaveAppState = (state: AppState) =>
  rpc(
    "/appState/save",
    SaveAppStateRequest.create({ state }),
    SaveAppStateRequest,
    SaveAppStateResponse,
  );
