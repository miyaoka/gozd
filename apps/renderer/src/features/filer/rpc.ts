import {
  ClipboardCopyFilesRequest,
  ClipboardCopyFilesResponse,
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileAbsoluteRequest,
  FsReadFileAbsoluteResponse,
  FsReadFileRequest,
  FsReadFileResponse,
  FsUnwatchFileAbsoluteRequest,
  FsUnwatchFileAbsoluteResponse,
  FsWatchFileAbsoluteRequest,
  FsWatchFileAbsoluteResponse,
  FsWriteFileAbsoluteRequest,
  FsWriteFileAbsoluteResponse,
  FsWriteFileRequest,
  FsWriteFileResponse,
  GitLsTreeRequest,
  GitLsTreeResponse,
  GitSubmoduleUrlRequest,
  GitSubmoduleUrlResponse,
  OpenFileRequest,
  OpenFileResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcFsReadDir = (req: FsReadDirRequest) => rpc<FsReadDirResponse>("/fs/readDir", req);

// snapshot mode (git-graph でコミット選択中) の filer が呼ぶ。
// hash 必須。空文字は main 側で reject される。
export const rpcGitLsTree = (req: GitLsTreeRequest) => rpc<GitLsTreeResponse>("/git/lsTree", req);

// submodule 行 click が呼ぶ。`.gitmodules` に記述が無い / 非 github.com host なら url 未設定で返る
// （呼び出し側が「リンク先が無い」ことを通知する責務を持つ）。
export const rpcGitSubmoduleUrl = (req: GitSubmoduleUrlRequest) =>
  rpc<GitSubmoduleUrlResponse>("/git/submoduleUrl", req);

export const rpcFsReadFile = (req: FsReadFileRequest) =>
  rpc<FsReadFileResponse>("/fs/readFile", req);

export const rpcFsReadFileAbsolute = (req: FsReadFileAbsoluteRequest) =>
  rpc<FsReadFileAbsoluteResponse>("/fs/readFileAbsolute", req);

// dir 配下への書き込み。path traversal guard は server 側 (resolveSafe)。
export const rpcFsWriteFile = (req: FsWriteFileRequest) =>
  rpc<FsWriteFileResponse>("/fs/writeFile", req);

// 絶対パスへの書き込み（dir 外を許可）。rpcFsReadFileAbsolute の書き込み対。
// 非絶対パスは main 側で reject される。
export const rpcFsWriteFileAbsolute = (req: FsWriteFileAbsoluteRequest) =>
  rpc<FsWriteFileAbsoluteResponse>("/fs/writeFileAbsolute", req);

// ファイル参照を OS クリップボードに書く（他アプリへの paste 用）。macOS pasteboard の
// ファイル参照形式は renderer の navigator.clipboard では書けないため main 側で行う。
export const rpcClipboardCopyFiles = (req: ClipboardCopyFilesRequest) =>
  rpc<ClipboardCopyFilesResponse>("/clipboard/copyFiles", req);

/** ファイルを OS のデフォルトアプリで開く（macOS の `open` 相当）。path は絶対パス。 */
export const rpcOpenFile = (req: OpenFileRequest) => rpc<OpenFileResponse>("/open/file", req);

// 絶対パスの単一ファイル watch（worktree 外。preview の表示中ファイル追従用）。
// 変更は fsChangeAbsolute push で届く。同一 path は main 側 refcount で共有される。
export const rpcFsWatchFileAbsolute = (req: FsWatchFileAbsoluteRequest) =>
  rpc<FsWatchFileAbsoluteResponse>("/fs/watchFileAbsolute", req);

export const rpcFsUnwatchFileAbsolute = (req: FsUnwatchFileAbsoluteRequest) =>
  rpc<FsUnwatchFileAbsoluteResponse>("/fs/unwatchFileAbsolute", req);
