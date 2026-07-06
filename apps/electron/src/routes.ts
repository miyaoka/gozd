// RPC ルート実装。
//
// ワイヤは `@gozd/rpc` の型を素の JSON で運ぶ。request は dispatcher が JSON.parse 済みの
// body を型 cast で受け（送り手は同型を参照する renderer なので構造は一致する契約）、
// response は `satisfies` でワイヤ契約の型チェックだけ通して素の object を返す。

import type {
  ClaudeSessionLogRequest,
  ClaudeSessionLogResponse,
  ClaudeSessionRemoveByPtyRequest,
  ClaudeSessionRemoveByPtyResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
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
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  LoadAppConfigResponse,
  LoadAppStateResponse,
  OpenExternalRequest,
  OpenExternalResponse,
  OpenFileRequest,
  OpenFileResponse,
  PickAndOpenResponse,
  ProjectConfigLoadRequest,
  ProjectConfigLoadResponse,
  ProjectConfigSaveRequest,
  ProjectConfigSaveResponse,
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
  ResumableSessionListRequest,
  ResumableSessionListResponse,
  ServerListResponse,
  ShellCommandInstallResponse,
  ShellCommandUninstallResponse,
  TaskAddRequest,
  TaskAddResponse,
  TaskListRequest,
  TaskListResponse,
  TaskRemoveRequest,
  TaskRemoveResponse,
  TaskSetTerminalTitleRequest,
  TaskSetTerminalTitleResponse,
  TaskSetUserTitleRequest,
  TaskSetUserTitleResponse,
  VoicevoxCheckEngineResponse,
  VoicevoxLaunchResponse,
  VoicevoxListSpeakersResponse,
  VoicevoxSpeakRequest,
  VoicevoxSpeakResponse,
  WindowCloseResponse,
  WindowSetTitleContextRequest,
  WindowSetTitleContextResponse,
  WindowSetServerPanelOpenResponse,
  WorktreeEntry,
} from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import { spawn, type IPty } from "node-pty";
import { readClaudeSessionLog } from "./claude/claudeSessionLog";
import { readDir, readFile, readFileAbsolute, stat, writeFile } from "./fs/fsOps";
import { createFsWatchRegistry } from "./fs/fsWatchRegistry";
import { blameLine, logFile, logLine } from "./git/gitBlame";
import { resolveStartPoint } from "./git/gitBranch";
import { diffHunks, expandDiffLines } from "./git/gitDiff";
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
import { createWorktree, removeWorktree } from "./git/worktreeOps";
import { fetchRemotes, gitStatusFull, worktreeList } from "./git/gitOps";
import { GitCommandError } from "./git/gitRunner";
import type { StatusFull } from "./git/porcelain";
import { issueList, prList, repoOwnerName, viewer } from "./git/github";
import { buildPtyEnv } from "./gozdEnv";
import { buildGozdOpenPayload } from "./openTarget";
import { loadProjectConfig, saveProjectConfig } from "./projectConfigStore";
import { createPortScanner, listProcParents, type PtyOwner } from "./portScanner";
import { clearAssociations, consumeExpectedResumeSid, registerSpawn, sessionIdFor, unregisterExit, worktreePathFor } from "./ptySessions";
import type { PushFn, RpcContext, RpcHandler } from "./rpcDispatcher";
import { listListenProcesses } from "./serverList";
import { installShellCommand, uninstallShellCommand } from "./shellCommandOps";
import { loadAppConfig, loadAppState, saveAppConfig, saveAppState } from "./stores";
import { taskStore } from "./taskStore";
import { checkEngine, launch as voicevoxLaunch, listSpeakers, speak } from "./voicevox";

const ptys = new Map<number, IPty>();
let nextPtyId = 1;

/** will-quit で全 PTY を始末する */
export function killAllPtys(): void {
  for (const pty of ptys.values()) {
    pty.kill();
  }
  ptys.clear();
}

// 実行中サーバーの周期検出（Swift 版 PortScanner 対応物）。push 先の window は
// main.ts が起動時に startPortScanner で bind する（fs watch push と同じ後付け束縛）
let serverPush: PushFn | undefined;
const portScanner = createPortScanner({
  listListenProcesses,
  listProcParents,
  // PTY の shell pid → 帰属先。scan のたびに現在の registry から引き直す
  ptyOwners: () => {
    const owners = new Map<number, PtyOwner>();
    for (const [ptyId, pty] of ptys) {
      owners.set(pty.pid, { ptyId, worktreePath: worktreePathFor(ptyId) });
    }
    return owners;
  },
  // 手組み dict payload（renderer の ServerPortsChangePayload と一致。attribution は文字列）
  onSnapshot: (servers) => {
    serverPush?.("serverPortsChange", { servers });
  },
});

export function startPortScanner(push: PushFn): void {
  serverPush = push;
  portScanner.start();
}

export function stopPortScanner(): void {
  portScanner.stop();
}

function handlePtySpawn(body: unknown, ctx: RpcContext): unknown {
  const req = body as PtySpawnRequest;
  if (req.dir === "") throw new Error("pty/spawn: dir is required");
  if (req.executable === "") throw new Error("pty/spawn: executable is required");

  const id = nextPtyId;
  nextPtyId++;

  // ワイヤ契約 (Swift PTYManager の execve 流儀): req.args は argv **全体** で、
  // args[0] = argv[0] (プログラム名)。node-pty は spawn(file, args) の args に
  // argv[0] を含めない ([file, ...args] を自前で組む) ため、args[0] を落として渡す。
  // 落とさないと `zsh /bin/zsh -i` のように実行され、zsh がバイナリをスクリプトとして
  // 読んで即死する (Mach-O マジックバイトの command not found + parse error)
  const pty = spawn(req.executable, req.args.slice(1), {
    name: "xterm-256color",
    cols: req.cols,
    rows: req.rows,
    cwd: req.dir,
    env: buildPtyEnv(req.env, id),
  });
  ptys.set(id, pty);
  // GOZD_RESUME_CLAUDE_SESSION（renderer が resume 起動時に載せる）を expected sid として
  // 記録する。SessionStart hook 着弾時に consume され、removeByPty 時点で残っていれば
  // resume 失敗（SessionStart 不達）と判定する
  registerSpawn(id, req.worktreePath, req.env.GOZD_RESUME_CLAUDE_SESSION ?? "");

  pty.onData((text) => {
    ctx.push("ptyText", { id, text });
  });
  pty.onExit(({ exitCode, signal }) => {
    ptys.delete(id);
    unregisterExit(id);
    // Swift PTYExitReason と同形の payload（terminal/rpc.ts の PtyExitReason 契約）
    const reason =
      signal !== undefined && signal !== 0
        ? { kind: "signaled", signal }
        : { kind: "exited", exitCode };
    ctx.push("ptyExit", { id, reason });
  });

  return ({ ptyId: id }) satisfies PtySpawnResponse;
}

function handlePtyWrite(body: unknown): unknown {
  const req = body as PtyWriteRequest;
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/write: unknown ptyId ${req.ptyId}`);
  pty.write(req.data);
  return ({}) satisfies PtyWriteResponse;
}

function handlePtyResize(body: unknown): unknown {
  const req = body as PtyResizeRequest;
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/resize: unknown ptyId ${req.ptyId}`);
  pty.resize(req.cols, req.rows);
  return ({}) satisfies PtyResizeResponse;
}

function handlePtyKill(body: unknown): unknown {
  const req = body as PtyKillRequest;
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/kill: unknown ptyId ${req.ptyId}`);
  pty.kill();
  ptys.delete(req.ptyId);
  return ({}) satisfies PtyKillResponse;
}

function handleEcho(body: unknown): unknown {
  const req = body as EchoRequest;
  return ({ text: req.text }) satisfies EchoResponse;
}

function handleAppConfigLoad(): unknown {
  return ({ config: loadAppConfig() }) satisfies LoadAppConfigResponse;
}

function handleAppConfigSave(body: unknown): unknown {
  const req = body as SaveAppConfigRequest;
  if (req.config === undefined) throw new Error("appConfig/save: config is required");
  saveAppConfig(req.config);
  return ({}) satisfies SaveAppConfigResponse;
}

function handleAppStateLoad(): unknown {
  return ({ state: loadAppState() }) satisfies LoadAppStateResponse;
}

function handleAppStateSave(body: unknown): unknown {
  const req = body as SaveAppStateRequest;
  if (req.state === undefined) throw new Error("appState/save: state is required");
  saveAppState(req.state);
  return ({}) satisfies SaveAppStateResponse;
}

function handleServerList(): unknown {
  // renderer mount 時の hydrate。周期 scan の直近 snapshot を返す。
  // attribution は push（serverPortsChange）と同じ文字列表現で、内部表現をそのまま流せる
  return { servers: portScanner.current() } satisfies ServerListResponse;
}

async function handleGitWorktreeList(body: unknown): Promise<unknown> {
  const req = body as GitWorktreeListRequest;
  const worktrees = await worktreeList(req.dir);
  const allTasks = await taskStore.list(req.dir);
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
  return ({ worktrees: entries }) satisfies GitWorktreeListResponse;
}

async function handleTaskList(body: unknown): Promise<unknown> {
  const req = body as TaskListRequest;
  return ({ tasks: await taskStore.list(req.dir) }) satisfies TaskListResponse;
}

async function handleTaskAdd(body: unknown): Promise<unknown> {
  const req = body as TaskAddRequest;
  const task = await taskStore.add({
    dir: req.dir,
    ghTitle: req.ghTitle,
    worktreeDir: req.worktreeDir,
    ghRef: req.ghRef,
  });
  return ({ task }) satisfies TaskAddResponse;
}

async function handleTaskSetTerminalTitle(body: unknown): Promise<unknown> {
  const req = body as TaskSetTerminalTitleRequest;
  const task = await taskStore.setTerminalTitle(req.dir, req.id, req.terminalTitle);
  return ({ task }) satisfies TaskSetTerminalTitleResponse;
}

async function handleTaskSetUserTitle(body: unknown): Promise<unknown> {
  const req = body as TaskSetUserTitleRequest;
  const task = await taskStore.setUserTitle(req.dir, req.id, req.userTitle);
  return ({ task }) satisfies TaskSetUserTitleResponse;
}

async function handleTaskRemove(body: unknown): Promise<unknown> {
  const req = body as TaskRemoveRequest;
  await taskStore.remove(req.dir, req.id);
  return ({}) satisfies TaskRemoveResponse;
}

async function handleResumableSessionList(body: unknown): Promise<unknown> {
  const req = body as ResumableSessionListRequest;
  return ({
    sessionIds: await taskStore.resumableSessionIds(req.dir),
  }) satisfies ResumableSessionListResponse;
}

async function handleGitGithubIdentity(body: unknown): Promise<unknown> {
  const req = body as GitGithubIdentityRequest;
  const identity = await repoOwnerName(req.dir);
  if (identity.kind === "ok") {
    return ({ owner: identity.owner, repo: identity.repo }) satisfies GitGithubIdentityResponse;
  }
  // remote 未設定 / 非 github.com host。UI には出ないが観察可能にする
  // （raw URL は credential 漏出防止のため stderr にも載せない）
  console.error(`[handleGitGithubIdentity] ${identity.kind} for dir=${req.dir}`);
  return ({ owner: "", repo: "" }) satisfies GitGithubIdentityResponse;
}

async function handleGitFetchRemotes(body: unknown): Promise<unknown> {
  const req = body as GitFetchRemotesRequest;
  const result = await tryCatch(fetchRemotes(req.dir));
  if (result.ok) return ({ ok: true, errorDetail: "" }) satisfies GitFetchRemotesResponse;
  // offline / 認証失敗 / remote 未設定 etc. は呼び出し側で握り潰す。
  // stderr 冒頭のみを debug 用に積む (UI には出さない)
  const detail =
    result.error instanceof GitCommandError
      ? result.error.stderr.slice(0, 512)
      : String(result.error);
  return ({ ok: false, errorDetail: detail }) satisfies GitFetchRemotesResponse;
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
  const req = body as FsReadFileRequest;
  const info = readFile(req.dir, req.path);
  return ({
    content: info.content,
    isBinary: info.isBinary,
    isDirectory: info.isDirectory,
    notFound: info.notFound,
  }) satisfies FsReadFileResponse;
}

async function handleFsReadDir(body: unknown): Promise<unknown> {
  const req = body as FsReadDirRequest;
  return (await readDir(req.dir, req.path)) satisfies FsReadDirResponse;
}

function handleFsReadFileAbsolute(body: unknown): unknown {
  const req = body as FsReadFileAbsoluteRequest;
  return ({ result: readFileAbsolute(req.absolutePath) }) satisfies FsReadFileAbsoluteResponse;
}

function handleFsWriteFile(body: unknown): unknown {
  const req = body as FsWriteFileRequest;
  writeFile(req.dir, req.path, req.content);
  return ({}) satisfies FsWriteFileResponse;
}

function handleFsStat(body: unknown): unknown {
  const req = body as FsStatRequest;
  return (stat(req.dir, req.path)) satisfies FsStatResponse;
}

async function handleGitStatus(body: unknown): Promise<unknown> {
  const req = body as GitStatusRequest;
  const status = await gitStatusFull(req.dir);
  return ({
    entries: status.statuses,
    renameOldPaths: status.renameOldPaths,
    latestMtime: status.latestMtime,
    upstream: status.hasUpstream ? { ahead: status.ahead, behind: status.behind } : undefined,
  }) satisfies GitStatusResponse;
}

async function handleFsWatch(body: unknown, ctx: RpcContext): Promise<unknown> {
  const req = body as FsWatchRequest;
  if (req.dir === "") throw new Error("fs/watch: dir is required");
  fsPush = ctx.push;
  await fsWatchRegistry.watch(req.dir);
  return ({}) satisfies FsWatchResponse;
}

function handleFsUnwatch(body: unknown): unknown {
  const req = body as FsUnwatchRequest;
  fsWatchRegistry.unwatch(req.dir);
  return ({}) satisfies FsUnwatchResponse;
}

function handleFsUnwatchAll(): unknown {
  return ({ unwatchedCount: fsWatchRegistry.unwatchAll() }) satisfies FsUnwatchAllResponse;
}

async function handleGitLog(body: unknown): Promise<unknown> {
  const req = body as GitLogRequest;
  const result = await log({
    dir: req.dir,
    maxCount: req.maxCount,
    firstParentOnly: req.firstParentOnly,
    currentBranchOnly: req.currentBranchOnly,
    sortMode: req.sortMode,
  });
  return (result) satisfies GitLogResponse;
}

async function handleGitMergeBase(body: unknown): Promise<unknown> {
  const req = body as GitMergeBaseRequest;
  return ({ mergeBaseOid: await mergeBase(req.dir, req.hash1, req.hash2) }) satisfies GitMergeBaseResponse;
}

async function handleGitRevReachable(body: unknown): Promise<unknown> {
  const req = body as GitRevReachableRequest;
  return ({ reachable: await revReachable(req.dir, req.hash) }) satisfies GitRevReachableResponse;
}

async function handleGitResetMixed(body: unknown): Promise<unknown> {
  const req = body as GitResetMixedRequest;
  await resetMixed(req.dir, req.hash);
  return ({}) satisfies GitResetMixedResponse;
}

async function handleGitDefaultBranch(body: unknown): Promise<unknown> {
  const req = body as GitDefaultBranchRequest;
  // GitCommandError（origin/HEAD 未設定 / detached HEAD 等のドメイン失敗）のみ空文字列に倒し、
  // spawn 失敗（git CLI 解決失敗）は throw して renderer に通知する
  const result = await tryCatch(resolveStartPoint(req.dir));
  if (!result.ok && !(result.error instanceof GitCommandError)) throw result.error;
  return ({ branch: result.ok ? result.value : "" }) satisfies GitDefaultBranchResponse;
}

async function handleGitBlameLine(body: unknown): Promise<unknown> {
  const req = body as GitBlameLineRequest;
  const commit = await blameLine({ dir: req.dir, relPath: req.relPath, rev: req.rev, line: req.line });
  return ({ commit }) satisfies GitBlameLineResponse;
}

async function handleGitLogLine(body: unknown): Promise<unknown> {
  const req = body as GitLogLineRequest;
  const commits = await logLine({
    dir: req.dir,
    relPath: req.relPath,
    rev: req.rev,
    line: req.line,
    maxCount: req.maxCount,
  });
  return ({ commits }) satisfies GitLogLineResponse;
}

async function handleGitLogFile(body: unknown): Promise<unknown> {
  const req = body as GitLogFileRequest;
  const commits = await logFile({
    dir: req.dir,
    relPath: req.relPath,
    rev: req.rev,
    maxCount: req.maxCount,
  });
  return ({ commits }) satisfies GitLogFileResponse;
}

async function handleGitDiffHunks(body: unknown): Promise<unknown> {
  const req = body as GitDiffHunksRequest;
  // gitDiff.ts の内部表現（kind 文字列含む）がワイヤ契約と一致するためそのまま返す
  const result = await diffHunks(req.original, req.current);
  return result satisfies GitDiffHunksResponse;
}

function handleGitDiffExpandLines(body: unknown): unknown {
  const req = body as GitDiffExpandLinesRequest;
  return ({
    lines: expandDiffLines(req.original, req.current, req.oldStart, req.newStart, req.lines),
  }) satisfies GitDiffExpandLinesResponse;
}

async function handleGitShowFile(body: unknown): Promise<unknown> {
  const req = body as GitShowFileRequest;
  return ({
    result: await fileReadResultFromGit(req.dir, "HEAD", req.relPath),
  }) satisfies GitShowFileResponse;
}

async function handleGitShowCommitFile(body: unknown): Promise<unknown> {
  const req = body as GitShowCommitFileRequest;
  // rev は `git show <rev>:<path>` / `git rev-parse` に渡るため、他 git ルートと同じ
  // 入口 safety net（option 注入 / 非 hex の reject）を通す。compareHash は空文字を許容
  validateRev(req.hash);
  validateRev(req.compareHash);
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
  return ({
    from,
    to,
    // 両 OID が解決でき、かつ一致した場合のみ true
    unchanged: fromOID !== undefined && toOID !== undefined && fromOID === toOID,
  }) satisfies GitShowCommitFileResponse;
}

function toFileChangeProto(change: FileChangeInfo): {
  oldFilePath: string;
  newFilePath: string;
  type: string;
} {
  return { oldFilePath: change.oldPath, newFilePath: change.newPath, type: change.type };
}

async function handleGitCommitFiles(body: unknown): Promise<unknown> {
  const req = body as GitCommitFilesRequest;
  const changes = await commitFiles({
    dir: req.dir,
    hash: req.hash,
    rangeHashes: req.rangeHashes,
    includeWorkingTree: req.includeWorkingTree,
  });
  return ({ changes: changes.map(toFileChangeProto) }) satisfies GitCommitFilesResponse;
}

async function handleGitPrDiffFiles(body: unknown): Promise<unknown> {
  const req = body as GitPrDiffFilesRequest;
  const changes = await prDiffFiles(req.dir, req.baseHash);
  return ({ changes: changes.map(toFileChangeProto) }) satisfies GitPrDiffFilesResponse;
}

async function handleGitReadBlob(body: unknown): Promise<unknown> {
  const req = body as GitReadBlobRequest;
  // rev は `git show <rev>:<path>` に渡るため option 注入を弾く validateRev を入口で通す
  validateRev(req.hash);
  return ({
    result: await fileReadResultFromGit(req.dir, req.hash, req.relPath),
  }) satisfies GitReadBlobResponse;
}

async function handleGitLsTree(body: unknown): Promise<unknown> {
  const req = body as GitLsTreeRequest;
  return ({ entries: await lsTree(req.dir, req.hash, req.path) }) satisfies GitLsTreeResponse;
}

async function handleGitPrList(body: unknown): Promise<unknown> {
  const req = body as GitPrListRequest;
  const result = await prList(req.dir);
  if (!result.ok) {
    return {
      ok: false,
      prs: [],
      errorKind: result.error.kind,
      errorDetail: result.error.detail,
    } satisfies GitPrListResponse;
  }
  return { ok: true, prs: result.value, errorKind: "ok", errorDetail: "" } satisfies GitPrListResponse;
}

async function handleGitIssueList(body: unknown): Promise<unknown> {
  const req = body as GitIssueListRequest;
  const result = await issueList(req.dir);
  if (!result.ok) {
    return {
      ok: false,
      issues: [],
      errorKind: result.error.kind,
      errorDetail: result.error.detail,
    } satisfies GitIssueListResponse;
  }
  return {
    ok: true,
    issues: result.value,
    errorKind: "ok",
    errorDetail: "",
  } satisfies GitIssueListResponse;
}

async function handleGitViewer(body: unknown): Promise<unknown> {
  const req = body as GitViewerRequest;
  const result = await viewer(req.dir);
  if (!result.ok) {
    return {
      ok: false,
      login: "",
      errorKind: result.error.kind,
      errorDetail: result.error.detail,
    } satisfies GitViewerResponse;
  }
  return { ok: true, login: result.value, errorKind: "ok", errorDetail: "" } satisfies GitViewerResponse;
}

async function handleCreateWorktree(body: unknown): Promise<unknown> {
  const req = body as CreateWorktreeRequest;
  const info = await createWorktree({
    dir: req.dir,
    worktreeDir: req.worktreeDir,
    branch: req.branch,
    startPoint: req.startPoint,
  });
  return ({
    worktree: {
      path: info.path,
      head: info.head,
      branch: info.branch ?? "",
      isMain: info.isMain,
      gitStatuses: {},
      renameOldPaths: {},
      latestMtime: 0,
      upstream: undefined,
      tasks: [],
    },
    dir: info.path,
  }) satisfies CreateWorktreeResponse;
}

async function handleWorktreeRemove(body: unknown, ctx: RpcContext): Promise<unknown> {
  const req = body as GitWorktreeRemoveRequest;
  await removeWorktree(req.dir, req.path, req.force);
  // worktree 物理削除に Task の片付けも連動させる。放置すると tasks.json に孤児 Task が残り
  // サイドバーにゾンビ行が出る。projectKey 解決は req.dir（main repo dir、削除されない側）から
  // 行う（req.path は物理削除済みなので anchor にすると projectKey が変わる）。失敗は notify で
  // ユーザーに伝える
  const cleanup = await tryCatch(taskStore.removeByWorktree(req.dir, req.path));
  if (!cleanup.ok) {
    console.error(`[TaskStore] removeTasksByWorktree failed: ${cleanup.error}`);
    ctx.push("notify", {
      type: "error",
      source: "task-store",
      message: "Failed to clean up tasks after worktree removal",
      detail: String(cleanup.error),
      dir: req.dir,
    });
  }
  return ({}) satisfies GitWorktreeRemoveResponse;
}

async function handleProjectConfigLoad(body: unknown): Promise<unknown> {
  const req = body as ProjectConfigLoadRequest;
  return ({ config: await loadProjectConfig(req.dir) }) satisfies ProjectConfigLoadResponse;
}

async function handleProjectConfigSave(body: unknown): Promise<unknown> {
  const req = body as ProjectConfigSaveRequest;
  if (req.config === undefined) throw new Error("projectConfig/save: config is required");
  await saveProjectConfig(req.dir, req.config);
  return ({}) satisfies ProjectConfigSaveResponse;
}

// `openExternal` で許可する URL scheme の allowlist。OSC 8 リンクや WebLinksAddon 経由で
// 任意 scheme が流れ込み得るので、ブラウザで開く想定の scheme のみを許可する
// （Swift 版 openExternalAllowedSchemes と同一集合）
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

async function handleOpenExternal(body: unknown): Promise<unknown> {
  const req = body as OpenExternalRequest;
  const parsed = tryCatch(() => new URL(req.url));
  if (!parsed.ok) throw new Error(`invalid url: ${req.url}`);
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(parsed.value.protocol)) {
    throw new Error(`scheme not allowed: ${parsed.value.protocol}`);
  }
  await shell.openExternal(req.url);
  return ({}) satisfies OpenExternalResponse;
}

async function handleOpenFile(body: unknown): Promise<unknown> {
  const req = body as OpenFileRequest;
  // path は renderer が解決済みの絶対パス契約。非絶対（空文字含む）を CWD 基準で silent に
  // 解決する暗黙 fallback を塞ぐため、入口で明示エラーに倒す（Swift 版と同じ規律）
  if (!req.path.startsWith("/")) {
    throw new Error(`path must be absolute: ${req.path}`);
  }
  // 存在チェックは契約検証ではなく、renderer 側の描画 gate を抜けた race
  // （表示直後に実体が消えた等）向けの safety net。無言 no-op を避けエラートーストを出す
  if (!existsSync(req.path)) {
    throw new Error(`file not found: ${req.path}`);
  }
  const errorMessage = await shell.openPath(req.path);
  if (errorMessage !== "") {
    throw new Error(`failed to open: ${errorMessage}`);
  }
  return ({}) satisfies OpenFileResponse;
}

async function handlePickAndOpen(_body: unknown, ctx: RpcContext): Promise<unknown> {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    buttonLabel: "Open",
    message: "Select a directory to open",
  });
  // ユーザーがキャンセルした場合は何もしない
  const [pickedPath = ""] = result.filePaths;
  if (!result.canceled && pickedPath !== "") {
    ctx.push("gozdOpen", await buildGozdOpenPayload(pickedPath));
  }
  return ({}) satisfies PickAndOpenResponse;
}

function handleWindowClose(): unknown {
  // シングルウィンドウ運用ではアプリ終了相当（Swift 版 NSApplication.terminate と同じ）
  app.quit();
  return ({}) satisfies WindowCloseResponse;
}

function handleWindowSetTitleContext(body: unknown): unknown {
  const req = body as WindowSetTitleContextRequest;
  // 表示整形（"repo · worktree"）は renderer のカスタムタイトルバーが SSOT。ここでは
  // Mission Control / Cmd+Tab に出る native window title に同じ文字列を反映するだけ。
  // gozd はシングルウィンドウなので全 window に適用で実質固定
  for (const window of BrowserWindow.getAllWindows()) {
    window.setTitle(req.title === "" ? "gozd" : req.title);
  }
  return ({}) satisfies WindowSetTitleContextResponse;
}

async function handleClaudeSessionRemoveByPty(body: unknown, ctx: RpcContext): Promise<unknown> {
  const req = body as ClaudeSessionRemoveByPtyRequest;
  // Swift handleClaudeSessionRemoveByPty と同一意味論。sessionId / worktreePath 紐付けは
  // 最後に必ずクリアする（tasks 側の cleanup が失敗しても late session-start hook を
  // 弾く必要があるため、各 taskStore 呼び出しは個別 tryCatch で notify に倒す）
  let removedSessionId = "";

  const liveSid = sessionIdFor(req.ptyId);
  const expectedSid = consumeExpectedResumeSid(req.ptyId);

  // SessionStart 着弾時点で expected は必ず消費されるため、removeByPty 時点で
  // 「expected と live が同居」は構造的に発生し得ない。到達したら consume 不変条件が
  // 壊れている兆候なので観察ログを残す（Swift は precondition で fatal にするが、
  // Electron main の fatal はダイアログ停止でハングに見えるため error ログに留める）
  if (expectedSid !== "" && liveSid !== "") {
    console.error(
      `[removeByPty] expectedSid (${expectedSid}) and liveSid (${liveSid}) both non-empty; SessionStart consume invariant broken`,
    );
  }

  if (expectedSid !== "") {
    // SessionStart hook が一度も着弾しないまま pane が閉じられた = `claude --resume` が
    // error 終了し zsh fallback も SessionStart 不達のまま終わったケース。sessionId を
    // 空に書き換え、次のクリックで素の claude 起動に流す。pane close の事実を
    // シグナル化するため markClosedByUser=true
    const cleared = await tryCatch(taskStore.clearDeadSession(req.worktreePath, expectedSid, true));
    if (!cleared.ok) {
      console.error(`[TaskStore] clearDeadSession failed: ${cleared.error}`);
      ctx.push("notify", {
        type: "error",
        source: "task-store",
        message: "Failed to clear dead session from task after resume failure",
        detail: String(cleared.error),
        dir: req.worktreePath,
      });
    }
  }

  if (liveSid !== "") {
    removedSessionId = liveSid;
    // ターミナル close は session-end hook を発火させないため、ここで明示的に
    // detachSession を呼び closed_by_user=true を立てる。task 本体と sessionID は保持
    const result = await tryCatch(taskStore.detachSession(req.worktreePath, liveSid));
    if (!result.ok) {
      console.error(`[TaskStore] detachSession (removeByPty) failed: ${result.error}`);
      ctx.push("notify", {
        type: "error",
        source: "task-store",
        message: "Failed to detach session on terminal close",
        detail: String(result.error),
        dir: req.worktreePath,
      });
    }
  } else if (expectedSid !== "") {
    // live なし + expected あり（純粋な resume 失敗）。removedSessionId に expected を
    // 載せて renderer に「何かは消した」と伝え、所属 repo の refetch を促す
    removedSessionId = expectedSid;
  }
  // else: live も expected もない素 PTY pane の close。正常経路でログ価値が薄い

  clearAssociations(req.ptyId);
  return ({ removedSessionId }) satisfies ClaudeSessionRemoveByPtyResponse;
}

function handleClaudeSessionReadLog(body: unknown): unknown {
  const req = body as ClaudeSessionLogRequest;
  const result = readClaudeSessionLog(req.sessionId);
  return ({
    found: result.found,
    watchDir: result.watchDir,
    entries: result.entries,
  }) satisfies ClaudeSessionLogResponse;
}

function handleShellCommandInstall(): unknown {
  return (installShellCommand()) satisfies ShellCommandInstallResponse;
}

function handleShellCommandUninstall(): unknown {
  return (uninstallShellCommand()) satisfies ShellCommandUninstallResponse;
}

async function handleVoicevoxLaunch(): Promise<unknown> {
  return ({ ok: await voicevoxLaunch() }) satisfies VoicevoxLaunchResponse;
}

async function handleVoicevoxCheckEngine(): Promise<unknown> {
  return ({ ok: await checkEngine() }) satisfies VoicevoxCheckEngineResponse;
}

async function handleVoicevoxListSpeakers(): Promise<unknown> {
  const speakers = await listSpeakers();
  // engine 起動失敗 / network 失敗は空 list にフォールバックしつつ、silent drop 禁止規律
  // として stderr に観察ログを残す（listSpeakers 内部でも要因別にログ済み）
  if (speakers === undefined) {
    console.error("[handleVoicevoxListSpeakers] listSpeakers returned undefined; responding with empty list");
  }
  return ({ speakers: speakers ?? [] }) satisfies VoicevoxListSpeakersResponse;
}

async function handleVoicevoxSpeak(body: unknown): Promise<unknown> {
  const req = body as VoicevoxSpeakRequest;
  const wav = await speak({
    text: req.text,
    speedScale: req.speedScale,
    volumeScale: req.volumeScale,
    speakerId: req.speakerId,
  });
  // 合成失敗時は空文字（ワイヤ契約: 失敗時は空。再生側が空をスキップする）
  return {
    wavBase64: wav === undefined ? "" : Buffer.from(wav).toString("base64"),
  } satisfies VoicevoxSpeakResponse;
}

function handleWindowSetServerPanelOpen(): unknown {
  // renderer が SSOT として持つパネル開閉状態を native titlebar トグルへミラーする RPC。
  // Electron shell には対応する native toolbar がまだ無いため受理のみ
  return ({}) satisfies WindowSetServerPanelOpenResponse;
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
  ["/git/createWorktree", handleCreateWorktree],
  ["/git/worktreeRemove", handleWorktreeRemove],
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
  ["/task/add", handleTaskAdd],
  ["/task/setTerminalTitle", handleTaskSetTerminalTitle],
  ["/task/setUserTitle", handleTaskSetUserTitle],
  ["/task/remove", handleTaskRemove],
  ["/task/resumableSessions", handleResumableSessionList],
  ["/projectConfig/load", handleProjectConfigLoad],
  ["/projectConfig/save", handleProjectConfigSave],
  ["/open/external", handleOpenExternal],
  ["/open/file", handleOpenFile],
  ["/open/pickAndOpen", handlePickAndOpen],
  ["/window/close", handleWindowClose],
  ["/window/setTitleContext", handleWindowSetTitleContext],
  ["/window/setServerPanelOpen", handleWindowSetServerPanelOpen],
  ["/claudeSession/removeByPty", handleClaudeSessionRemoveByPty],
  ["/claudeSession/readLog", handleClaudeSessionReadLog],
  ["/shellCommand/install", handleShellCommandInstall],
  ["/shellCommand/uninstall", handleShellCommandUninstall],
  ["/voicevox/launch", handleVoicevoxLaunch],
  ["/voicevox/checkEngine", handleVoicevoxCheckEngine],
  ["/voicevox/listSpeakers", handleVoicevoxListSpeakers],
  ["/voicevox/speak", handleVoicevoxSpeak],
]);
