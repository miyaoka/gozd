// RPC ルート実装。Swift 版 handler 群の対応物。
//
// proto3 JSON ⇔ message の変換は `@gozd/proto`（ts-proto 生成物）の
// fromJSON / toJSON をそのまま使う。ワイヤ形式・push payload の形は
// Swift shell（AppRuntime.swift の pushToRenderer）と一致させる契約。

import {
  DiffLineKind,
  EchoRequest,
  EchoResponse,
  FsReadDirRequest,
  FsReadDirResponse,
  FsReadFileAbsoluteRequest,
  FsReadFileAbsoluteResponse,
  FsReadFileRequest,
  FsReadFileResponse,
  FsStatRequest,
  FsStatResponse,
  FsUnwatchAllRequest,
  FsUnwatchAllResponse,
  FsUnwatchRequest,
  FsUnwatchResponse,
  FsWatchRequest,
  FsWatchResponse,
  FsWriteFileRequest,
  FsWriteFileResponse,
  GitCommitFilesRequest,
  GitCommitFilesResponse,
  GitDefaultBranchRequest,
  GitDefaultBranchResponse,
  GitDiffExpandLinesRequest,
  GitDiffExpandLinesResponse,
  GitDiffHunksRequest,
  GitDiffHunksResponse,
  GitBlameLineRequest,
  GitBlameLineResponse,
  GhErrorKind,
  GitFetchRemotesRequest,
  GitFetchRemotesResponse,
  GitGithubIdentityRequest,
  GitGithubIdentityResponse,
  GitIssueListRequest,
  GitIssueListResponse,
  GitLogFileRequest,
  GitLogFileResponse,
  GitLogLineRequest,
  GitLogLineResponse,
  GitLogRequest,
  GitLogResponse,
  GitLsTreeRequest,
  GitLsTreeResponse,
  GitMergeBaseRequest,
  GitMergeBaseResponse,
  GitPrDiffFilesRequest,
  GitPrDiffFilesResponse,
  GitPrListRequest,
  GitPrListResponse,
  GitReadBlobRequest,
  GitReadBlobResponse,
  GitResetMixedRequest,
  GitResetMixedResponse,
  GitRevReachableRequest,
  GitRevReachableResponse,
  GitShowCommitFileRequest,
  GitShowCommitFileResponse,
  GitShowFileRequest,
  GitShowFileResponse,
  GitStatusRequest,
  GitStatusResponse,
  GitViewerRequest,
  GitViewerResponse,
  GitWorktreeListRequest,
  GitWorktreeListResponse,
  SortMode,
  LoadAppConfigResponse,
  LoadAppStateResponse,
  PtyKillRequest,
  PtyKillResponse,
  PtyResizeRequest,
  PtyResizeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
  SaveAppConfigRequest,
  SaveAppConfigResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
  ServerListResponse,
  TaskListRequest,
  TaskListResponse,
  WindowSetServerPanelOpenResponse,
  type WorktreeEntry,
} from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { spawn, type IPty } from "node-pty";
import { readDir, readFile, readFileAbsolute, stat, writeFile } from "./fs/fsOps";
import { createFsWatchRegistry } from "./fs/fsWatchRegistry";
import { blameLine, logFile, logLine } from "./git/gitBlame";
import { resolveStartPoint } from "./git/gitBranch";
import { diffHunks, expandDiffLines, type DiffHunkLineKind } from "./git/gitDiff";
import { log, mergeBase, resetMixed, revReachable } from "./git/gitLog";
import {
  commitFiles,
  fileReadResultFromGit,
  lsTree,
  prDiffFiles,
  treeFileOID,
  type FileChangeInfo,
} from "./git/gitTree";
import { validateRev } from "./git/gitValidate";
import { fetchRemotes, gitStatusFull, worktreeList } from "./git/gitOps";
import { GitCommandError } from "./git/gitRunner";
import type { StatusFull } from "./git/porcelain";
import { issueList, prList, repoOwnerName, viewer, type GhErrorKindName } from "./git/github";
import type { PushFn, RpcContext, RpcHandler } from "./rpcDispatcher";
import { scanListenServers } from "./serverList";
import { loadAppConfig, loadAppState, saveAppConfig, saveAppState } from "./stores";
import { listTasks } from "./taskStore";

const ptys = new Map<number, IPty>();
let nextPtyId = 1;

/** will-quit で全 PTY を始末する */
export function killAllPtys(): void {
  for (const pty of ptys.values()) {
    pty.kill();
  }
  ptys.clear();
}

// Swift PTYManager が注入するターミナル環境変数と同一（docs/architecture.md）。
// GOZD_PTY_ID / GOZD_SOCKET_PATH 等の gozd 固有変数は hooks 統合ステップで移植する
const TERMINAL_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "gozd",
  FORCE_HYPERLINK: "1",
};

function buildPtyEnv(overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...TERMINAL_ENV, ...overlay };
}

function handlePtySpawn(body: unknown, ctx: RpcContext): unknown {
  const req = PtySpawnRequest.fromJSON(body);
  if (req.dir === "") throw new Error("pty/spawn: dir is required");
  if (req.executable === "") throw new Error("pty/spawn: executable is required");

  const id = nextPtyId;
  nextPtyId++;

  const pty = spawn(req.executable, req.args, {
    name: "xterm-256color",
    cols: req.cols,
    rows: req.rows,
    cwd: req.dir,
    env: buildPtyEnv(req.env),
  });
  ptys.set(id, pty);

  pty.onData((text) => {
    ctx.push("ptyText", { id, text });
  });
  pty.onExit(({ exitCode, signal }) => {
    ptys.delete(id);
    // Swift PTYExitReason と同形の payload（terminal/rpc.ts の PtyExitReason 契約）
    const reason =
      signal !== undefined && signal !== 0
        ? { kind: "signaled", signal }
        : { kind: "exited", exitCode };
    ctx.push("ptyExit", { id, reason });
  });

  return PtySpawnResponse.toJSON({ ptyId: id });
}

function handlePtyWrite(body: unknown): unknown {
  const req = PtyWriteRequest.fromJSON(body);
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/write: unknown ptyId ${req.ptyId}`);
  pty.write(Buffer.from(req.data).toString("utf8"));
  return PtyWriteResponse.toJSON({});
}

function handlePtyResize(body: unknown): unknown {
  const req = PtyResizeRequest.fromJSON(body);
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/resize: unknown ptyId ${req.ptyId}`);
  pty.resize(req.cols, req.rows);
  return PtyResizeResponse.toJSON({});
}

function handlePtyKill(body: unknown): unknown {
  const req = PtyKillRequest.fromJSON(body);
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/kill: unknown ptyId ${req.ptyId}`);
  pty.kill();
  ptys.delete(req.ptyId);
  return PtyKillResponse.toJSON({});
}

function handleEcho(body: unknown): unknown {
  const req = EchoRequest.fromJSON(body);
  return EchoResponse.toJSON({ text: req.text });
}

function handleAppConfigLoad(): unknown {
  return LoadAppConfigResponse.toJSON({ config: loadAppConfig() });
}

function handleAppConfigSave(body: unknown): unknown {
  const req = SaveAppConfigRequest.fromJSON(body);
  if (req.config === undefined) throw new Error("appConfig/save: config is required");
  saveAppConfig(req.config);
  return SaveAppConfigResponse.toJSON({});
}

function handleAppStateLoad(): unknown {
  return LoadAppStateResponse.toJSON({ state: loadAppState() });
}

function handleAppStateSave(body: unknown): unknown {
  const req = SaveAppStateRequest.fromJSON(body);
  if (req.state === undefined) throw new Error("appState/save: state is required");
  saveAppState(req.state);
  return SaveAppStateResponse.toJSON({});
}

async function handleServerList(): Promise<unknown> {
  return ServerListResponse.toJSON({ servers: await scanListenServers() });
}

async function handleGitWorktreeList(body: unknown): Promise<unknown> {
  const req = GitWorktreeListRequest.fromJSON(body);
  const worktrees = await worktreeList(req.dir);
  const allTasks = await listTasks(req.dir);
  // 各 wt の git status は補助データ。1 wt の失敗で worktree list 全体を捨てないため、
  // per-wt で握って空 statuses で続行する（prunable wt は listing から除外済みなので、
  // ここで失敗するのは worktree 実 path 不整合などの稀ケース）。失敗は stderr に残す
  const entries: WorktreeEntry[] = await Promise.all(
    worktrees.map(async (wt) => {
      const full = await tryCatch(gitStatusFull(wt.path));
      if (!full.ok) {
        console.error(`[handleGitWorktreeList] gitStatusFull failed for ${wt.path}: ${full.error}`);
      }
      const status = full.ok ? full.value : undefined;
      return {
        path: wt.path,
        head: wt.head,
        branch: wt.branch ?? "",
        isMain: wt.isMain,
        gitStatuses: status?.statuses ?? {},
        renameOldPaths: status?.renameOldPaths ?? {},
        latestMtime: status?.latestMtime ?? 0,
        upstream: status?.hasUpstream ? { ahead: status.ahead, behind: status.behind } : undefined,
        // 1 wt = 複数 Claude session の前提で session 単位の Task が複数並ぶ
        tasks: allTasks.filter((task) => task.worktreeDir === wt.path),
      };
    }),
  );
  return GitWorktreeListResponse.toJSON({ worktrees: entries });
}

async function handleTaskList(body: unknown): Promise<unknown> {
  const req = TaskListRequest.fromJSON(body);
  return TaskListResponse.toJSON({ tasks: await listTasks(req.dir) });
}

async function handleGitGithubIdentity(body: unknown): Promise<unknown> {
  const req = GitGithubIdentityRequest.fromJSON(body);
  const identity = await repoOwnerName(req.dir);
  if (identity.kind === "ok") {
    return GitGithubIdentityResponse.toJSON({ owner: identity.owner, repo: identity.repo });
  }
  // remote 未設定 / 非 github.com host。UI には出ないが観察可能にする
  // （raw URL は credential 漏出防止のため stderr にも載せない）
  console.error(`[handleGitGithubIdentity] ${identity.kind} for dir=${req.dir}`);
  return GitGithubIdentityResponse.toJSON({ owner: "", repo: "" });
}

async function handleGitFetchRemotes(body: unknown): Promise<unknown> {
  const req = GitFetchRemotesRequest.fromJSON(body);
  const result = await tryCatch(fetchRemotes(req.dir));
  if (result.ok) return GitFetchRemotesResponse.toJSON({ ok: true, errorDetail: "" });
  // offline / 認証失敗 / remote 未設定 etc. は呼び出し側で握り潰す。
  // stderr 冒頭のみを debug 用に積む (UI には出さない)
  const detail =
    result.error instanceof GitCommandError
      ? result.error.stderr.slice(0, 512)
      : String(result.error);
  return GitFetchRemotesResponse.toJSON({ ok: false, errorDetail: detail });
}

// fs watch の push は「最後に /fs/watch を呼んだ window」の sender に配送する。
// registry は request をまたいで生き続けるため、per-request の ctx.push をそのまま束縛できない。
// gozd はシングルウィンドウなので実質固定（Swift 版も単一 WebPage への push で同じ前提）。
// マルチウィンドウ化する場合は dir → sender の対応を registry 側に持たせる必要がある
let fsPush: PushFn | undefined;

/** AppRuntime.swift の onGitStatusChange と同形の payload を組む */
function gitStatusChangePayload(dir: string, status: StatusFull): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    dir,
    statuses: status.statuses,
    renameOldPaths: status.renameOldPaths,
    head: status.head,
    branchHead: status.branchHead,
    latestMtime: status.latestMtime,
  };
  // upstream 未設定なら upstream フィールドごと不在にする。renderer 側は
  // `upstream === undefined` を「ahead/behind を読まない」契約として扱う
  if (status.hasUpstream) {
    payload.upstream = { ahead: status.ahead, behind: status.behind };
  }
  return payload;
}

const fsWatchRegistry = createFsWatchRegistry({
  onFsChange: (dir, relDir) => fsPush?.("fsChange", { dir, relDir }),
  onGitStatusChange: (dir, status) => fsPush?.("gitStatusChange", gitStatusChangePayload(dir, status)),
  onBranchChange: (dir) => fsPush?.("branchChange", { dir }),
  onRemoteRefsChange: (dir) => fsPush?.("remoteRefsChange", { dir }),
  onWorktreeChange: (dir) => fsPush?.("worktreeChange", { dir }),
});

/** will-quit で全 watch を始末する（watcher スレッドの残骸を残さない） */
export function unwatchAllFsWatches(): void {
  fsWatchRegistry.unwatchAll();
}

function handleFsReadFile(body: unknown): unknown {
  const req = FsReadFileRequest.fromJSON(body);
  const info = readFile(req.dir, req.path);
  return FsReadFileResponse.toJSON({
    content: info.content,
    isBinary: info.isBinary,
    isDirectory: info.isDirectory,
    notFound: info.notFound,
  });
}

async function handleFsReadDir(body: unknown): Promise<unknown> {
  const req = FsReadDirRequest.fromJSON(body);
  return FsReadDirResponse.toJSON(await readDir(req.dir, req.path));
}

function handleFsReadFileAbsolute(body: unknown): unknown {
  const req = FsReadFileAbsoluteRequest.fromJSON(body);
  return FsReadFileAbsoluteResponse.toJSON({ result: readFileAbsolute(req.absolutePath) });
}

function handleFsWriteFile(body: unknown): unknown {
  const req = FsWriteFileRequest.fromJSON(body);
  writeFile(req.dir, req.path, req.data);
  return FsWriteFileResponse.toJSON({});
}

function handleFsStat(body: unknown): unknown {
  const req = FsStatRequest.fromJSON(body);
  return FsStatResponse.toJSON(stat(req.dir, req.path));
}

async function handleGitStatus(body: unknown): Promise<unknown> {
  const req = GitStatusRequest.fromJSON(body);
  const status = await gitStatusFull(req.dir);
  return GitStatusResponse.toJSON({
    entries: status.statuses,
    renameOldPaths: status.renameOldPaths,
    latestMtime: status.latestMtime,
    upstream: status.hasUpstream ? { ahead: status.ahead, behind: status.behind } : undefined,
  });
}

async function handleFsWatch(body: unknown, ctx: RpcContext): Promise<unknown> {
  const req = FsWatchRequest.fromJSON(body);
  if (req.dir === "") throw new Error("fs/watch: dir is required");
  fsPush = ctx.push;
  await fsWatchRegistry.watch(req.dir);
  return FsWatchResponse.toJSON({});
}

function handleFsUnwatch(body: unknown): unknown {
  const req = FsUnwatchRequest.fromJSON(body);
  fsWatchRegistry.unwatch(req.dir);
  return FsUnwatchResponse.toJSON({});
}

function handleFsUnwatchAll(body: unknown): unknown {
  FsUnwatchAllRequest.fromJSON(body);
  return FsUnwatchAllResponse.toJSON({ unwatchedCount: fsWatchRegistry.unwatchAll() });
}

async function handleGitLog(body: unknown): Promise<unknown> {
  const req = GitLogRequest.fromJSON(body);
  const result = await log({
    dir: req.dir,
    maxCount: req.maxCount,
    firstParentOnly: req.firstParentOnly,
    currentBranchOnly: req.currentBranchOnly,
    sortMode: req.sortMode === SortMode.SORT_MODE_DATE ? "date" : "topo",
  });
  return GitLogResponse.toJSON(result);
}

async function handleGitMergeBase(body: unknown): Promise<unknown> {
  const req = GitMergeBaseRequest.fromJSON(body);
  return GitMergeBaseResponse.toJSON({ mergeBaseOid: await mergeBase(req.dir, req.hash1, req.hash2) });
}

async function handleGitRevReachable(body: unknown): Promise<unknown> {
  const req = GitRevReachableRequest.fromJSON(body);
  return GitRevReachableResponse.toJSON({ reachable: await revReachable(req.dir, req.hash) });
}

async function handleGitResetMixed(body: unknown): Promise<unknown> {
  const req = GitResetMixedRequest.fromJSON(body);
  await resetMixed(req.dir, req.hash);
  return GitResetMixedResponse.toJSON({});
}

async function handleGitDefaultBranch(body: unknown): Promise<unknown> {
  const req = GitDefaultBranchRequest.fromJSON(body);
  // GitCommandError（origin/HEAD 未設定 / detached HEAD 等のドメイン失敗）のみ空文字列に倒し、
  // spawn 失敗（git CLI 解決失敗）は throw して renderer に通知する
  const result = await tryCatch(resolveStartPoint(req.dir));
  if (!result.ok && !(result.error instanceof GitCommandError)) throw result.error;
  return GitDefaultBranchResponse.toJSON({ branch: result.ok ? result.value : "" });
}

async function handleGitBlameLine(body: unknown): Promise<unknown> {
  const req = GitBlameLineRequest.fromJSON(body);
  const commit = await blameLine({ dir: req.dir, relPath: req.relPath, rev: req.rev, line: req.line });
  return GitBlameLineResponse.toJSON({ commit });
}

async function handleGitLogLine(body: unknown): Promise<unknown> {
  const req = GitLogLineRequest.fromJSON(body);
  const commits = await logLine({
    dir: req.dir,
    relPath: req.relPath,
    rev: req.rev,
    line: req.line,
    maxCount: req.maxCount,
  });
  return GitLogLineResponse.toJSON({ commits });
}

async function handleGitLogFile(body: unknown): Promise<unknown> {
  const req = GitLogFileRequest.fromJSON(body);
  const commits = await logFile({
    dir: req.dir,
    relPath: req.relPath,
    rev: req.rev,
    maxCount: req.maxCount,
  });
  return GitLogFileResponse.toJSON({ commits });
}

const DIFF_LINE_KIND_PROTO: Record<DiffHunkLineKind, DiffLineKind> = {
  context: DiffLineKind.DIFF_LINE_KIND_CONTEXT,
  added: DiffLineKind.DIFF_LINE_KIND_ADDED,
  removed: DiffLineKind.DIFF_LINE_KIND_REMOVED,
};

async function handleGitDiffHunks(body: unknown): Promise<unknown> {
  const req = GitDiffHunksRequest.fromJSON(body);
  const result = await diffHunks(req.original, req.current);
  return GitDiffHunksResponse.toJSON({
    oldTotalLines: result.oldTotalLines,
    newTotalLines: result.newTotalLines,
    hunks: result.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ kind: DIFF_LINE_KIND_PROTO[line.kind], text: line.text })),
    })),
  });
}

function handleGitDiffExpandLines(body: unknown): unknown {
  const req = GitDiffExpandLinesRequest.fromJSON(body);
  return GitDiffExpandLinesResponse.toJSON({
    lines: expandDiffLines(req.original, req.current, req.oldStart, req.newStart, req.lines),
  });
}

async function handleGitShowFile(body: unknown): Promise<unknown> {
  const req = GitShowFileRequest.fromJSON(body);
  return GitShowFileResponse.toJSON({
    result: await fileReadResultFromGit(req.dir, "HEAD", req.relPath),
  });
}

async function handleGitShowCommitFile(body: unknown): Promise<unknown> {
  const req = GitShowCommitFileRequest.fromJSON(body);
  // 単一コミット選択 (compareHash 空) では GitHub と同等の <hash>^ vs <hash> 比較に揃える
  // （commitFiles のファイル一覧と diff endpoint を一致させる。root commit は <hash>^ が
  // 解決失敗 → notFound=true となり追加扱いに自然解決する）。範囲選択 (compareHash 非空) では
  // commitFiles の <older>^ vs <newer> に揃え、older 端自身の変更も diff に含める。
  // Working Tree 端の扱いは renderer 側で分岐し、wire には常に実 git hash のみ流れる契約
  const olderEnd = req.compareHash === "" ? req.hash : req.compareHash;
  const fromHash = `${olderEnd}^`;
  // content と OID を並行取得。両端の blob OID が一致すれば「コミット範囲で変更なし」として
  // renderer に伝える（Filer 経由の非変更ファイル選択を救済）
  const [from, to, fromOID, toOID] = await Promise.all([
    fileReadResultFromGit(req.dir, fromHash, req.relPath),
    fileReadResultFromGit(req.dir, req.hash, req.relPath),
    treeFileOID(req.dir, fromHash, req.relPath),
    treeFileOID(req.dir, req.hash, req.relPath),
  ]);
  return GitShowCommitFileResponse.toJSON({
    from,
    to,
    // 両 OID が解決でき、かつ一致した場合のみ true
    unchanged: fromOID !== undefined && toOID !== undefined && fromOID === toOID,
  });
}

function toFileChangeProto(change: FileChangeInfo): {
  oldFilePath: string;
  newFilePath: string;
  type: string;
} {
  return { oldFilePath: change.oldPath, newFilePath: change.newPath, type: change.type };
}

async function handleGitCommitFiles(body: unknown): Promise<unknown> {
  const req = GitCommitFilesRequest.fromJSON(body);
  const changes = await commitFiles({
    dir: req.dir,
    hash: req.hash,
    rangeHashes: req.rangeHashes,
    includeWorkingTree: req.includeWorkingTree,
  });
  return GitCommitFilesResponse.toJSON({ changes: changes.map(toFileChangeProto) });
}

async function handleGitPrDiffFiles(body: unknown): Promise<unknown> {
  const req = GitPrDiffFilesRequest.fromJSON(body);
  const changes = await prDiffFiles(req.dir, req.baseHash);
  return GitPrDiffFilesResponse.toJSON({ changes: changes.map(toFileChangeProto) });
}

async function handleGitReadBlob(body: unknown): Promise<unknown> {
  const req = GitReadBlobRequest.fromJSON(body);
  // rev は `git show <rev>:<path>` に渡るため option 注入を弾く validateRev を入口で通す
  validateRev(req.hash);
  return GitReadBlobResponse.toJSON({
    result: await fileReadResultFromGit(req.dir, req.hash, req.relPath),
  });
}

async function handleGitLsTree(body: unknown): Promise<unknown> {
  const req = GitLsTreeRequest.fromJSON(body);
  return GitLsTreeResponse.toJSON({ entries: await lsTree(req.dir, req.hash, req.path) });
}

const GH_ERROR_KIND_PROTO: Record<GhErrorKindName, GhErrorKind> = {
  rateLimit: GhErrorKind.GH_ERROR_KIND_RATE_LIMIT,
  unauthenticated: GhErrorKind.GH_ERROR_KIND_UNAUTHENTICATED,
  repoNotFound: GhErrorKind.GH_ERROR_KIND_REPO_NOT_FOUND,
  network: GhErrorKind.GH_ERROR_KIND_NETWORK,
  other: GhErrorKind.GH_ERROR_KIND_OTHER,
};

async function handleGitPrList(body: unknown): Promise<unknown> {
  const req = GitPrListRequest.fromJSON(body);
  const result = await prList(req.dir);
  if (!result.ok) {
    return GitPrListResponse.toJSON({
      ok: false,
      prs: [],
      errorKind: GH_ERROR_KIND_PROTO[result.error.kind],
      errorDetail: result.error.detail,
    });
  }
  return GitPrListResponse.toJSON({
    ok: true,
    prs: result.value,
    errorKind: GhErrorKind.GH_ERROR_KIND_OK,
    errorDetail: "",
  });
}

async function handleGitIssueList(body: unknown): Promise<unknown> {
  const req = GitIssueListRequest.fromJSON(body);
  const result = await issueList(req.dir);
  if (!result.ok) {
    return GitIssueListResponse.toJSON({
      ok: false,
      issues: [],
      errorKind: GH_ERROR_KIND_PROTO[result.error.kind],
      errorDetail: result.error.detail,
    });
  }
  return GitIssueListResponse.toJSON({
    ok: true,
    issues: result.value,
    errorKind: GhErrorKind.GH_ERROR_KIND_OK,
    errorDetail: "",
  });
}

async function handleGitViewer(body: unknown): Promise<unknown> {
  const req = GitViewerRequest.fromJSON(body);
  const result = await viewer(req.dir);
  if (!result.ok) {
    return GitViewerResponse.toJSON({
      ok: false,
      login: "",
      errorKind: GH_ERROR_KIND_PROTO[result.error.kind],
      errorDetail: result.error.detail,
    });
  }
  return GitViewerResponse.toJSON({
    ok: true,
    login: result.value,
    errorKind: GhErrorKind.GH_ERROR_KIND_OK,
    errorDetail: "",
  });
}

function handleWindowSetServerPanelOpen(): unknown {
  // renderer が SSOT として持つパネル開閉状態を native titlebar トグルへミラーする RPC。
  // Electron shell には対応する native toolbar がまだ無いため受理のみ
  return WindowSetServerPanelOpenResponse.toJSON({});
}

export const routes: ReadonlyMap<string, RpcHandler> = new Map<string, RpcHandler>([
  ["/echo", handleEcho],
  ["/appConfig/load", handleAppConfigLoad],
  ["/appConfig/save", handleAppConfigSave],
  ["/appState/load", handleAppStateLoad],
  ["/appState/save", handleAppStateSave],
  ["/fs/readFile", handleFsReadFile],
  ["/fs/readDir", handleFsReadDir],
  ["/fs/readFileAbsolute", handleFsReadFileAbsolute],
  ["/fs/writeFile", handleFsWriteFile],
  ["/fs/stat", handleFsStat],
  ["/fs/watch", handleFsWatch],
  ["/fs/unwatch", handleFsUnwatch],
  ["/fs/unwatchAll", handleFsUnwatchAll],
  ["/git/status", handleGitStatus],
  ["/git/log", handleGitLog],
  ["/git/diffHunks", handleGitDiffHunks],
  ["/git/diffExpandLines", handleGitDiffExpandLines],
  ["/git/showFile", handleGitShowFile],
  ["/git/showCommitFile", handleGitShowCommitFile],
  ["/git/commitFiles", handleGitCommitFiles],
  ["/git/prDiffFiles", handleGitPrDiffFiles],
  ["/git/readBlob", handleGitReadBlob],
  ["/git/lsTree", handleGitLsTree],
  ["/git/blameLine", handleGitBlameLine],
  ["/git/logLine", handleGitLogLine],
  ["/git/logFile", handleGitLogFile],
  ["/git/mergeBase", handleGitMergeBase],
  ["/git/revReachable", handleGitRevReachable],
  ["/git/resetMixed", handleGitResetMixed],
  ["/git/defaultBranch", handleGitDefaultBranch],
  ["/git/prList", handleGitPrList],
  ["/git/issueList", handleGitIssueList],
  ["/git/viewer", handleGitViewer],
  ["/git/worktreeList", handleGitWorktreeList],
  ["/git/githubIdentity", handleGitGithubIdentity],
  ["/git/fetchRemotes", handleGitFetchRemotes],
  ["/pty/spawn", handlePtySpawn],
  ["/pty/write", handlePtyWrite],
  ["/pty/resize", handlePtyResize],
  ["/pty/kill", handlePtyKill],
  ["/server/list", handleServerList],
  ["/task/list", handleTaskList],
  ["/window/setServerPanelOpen", handleWindowSetServerPanelOpen],
]);
