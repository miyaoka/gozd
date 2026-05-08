import {
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileAbsoluteRequest,
  FsReadFileAbsoluteResponse,
  FsReadFileRequest,
  FsReadFileResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcFsReadDir = (req: FsReadDirRequest) =>
  rpc("/fs/readDir", req, FsReadDirRequest, FsReadDirResponse);

export const rpcFsReadFile = (req: FsReadFileRequest) =>
  rpc("/fs/readFile", req, FsReadFileRequest, FsReadFileResponse);

export const rpcFsReadFileAbsolute = (req: FsReadFileAbsoluteRequest) =>
  rpc("/fs/readFileAbsolute", req, FsReadFileAbsoluteRequest, FsReadFileAbsoluteResponse);

// fsChange push event payload
export interface FsChangePayload {
  relDir: string;
}
