import {
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileAbsoluteRequest,
  FsReadFileAbsoluteResponse,
  FsReadFileRequest,
  FsReadFileResponse,
  FsUnwatchRequest,
  FsUnwatchResponse,
  FsWatchRequest,
  FsWatchResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcFsReadDir = (req: FsReadDirRequest) =>
  rpc("/fs/readDir", req, FsReadDirRequest, FsReadDirResponse);

export const rpcFsReadFile = (req: FsReadFileRequest) =>
  rpc("/fs/readFile", req, FsReadFileRequest, FsReadFileResponse);

export const rpcFsReadFileAbsolute = (req: FsReadFileAbsoluteRequest) =>
  rpc("/fs/readFileAbsolute", req, FsReadFileAbsoluteRequest, FsReadFileAbsoluteResponse);

export const rpcFsWatch = (req: FsWatchRequest) =>
  rpc("/fs/watch", req, FsWatchRequest, FsWatchResponse);

export const rpcFsUnwatch = (req: FsUnwatchRequest) =>
  rpc("/fs/unwatch", req, FsUnwatchRequest, FsUnwatchResponse);

// fsChange push event payload
export interface FsChangePayload {
  dir: string;
  relDir: string;
}
