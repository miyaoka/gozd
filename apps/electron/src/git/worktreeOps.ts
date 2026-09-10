// worktree / branch を変更する書き込み系操作。Swift 版 `WorktreeOps.swift` の対応物。
// 読み取り系（list / log）は gitOps / gitLog。新規作成経路の合成（main repo root の解決 →
// 起点 ref と leaf 名の既定値決定 → 作成）は worktreeCreate。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync, readdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { generateTimestamp, tryCatch } from "@gozd/shared";
import { resolveContained } from "../fs/pathContainment";
import { gozdWorktreesRoot, resolveMainRepoRoot, resolveProjectKey } from "../taskStore";
import { resolveStartPoint } from "./gitBranch";
import { perWorktreeGitDir, worktreeList } from "./gitOps";
import { runGit } from "./gitRunner";
import type { WorktreeInfo } from "./porcelain";

/**
 * `git worktree add [-B <branch>] [--no-track] <path> [<commit-ish>]` 相当。
 *
 * `worktreeDir` はリーフ名（typically タイムスタンプ）。リポジトリ汚染を避けるため
 * `~/.local/share/gozd/worktrees/<projectKey>/<worktreeDir>` に絶対パスとして配置する。
 * `dir` は main repo / worktree subdir のどれでも可（projectKey 解決で main repo root に揃う）。
 *
 * startPoint があれば -B で新規 or リセットしてブランチ作成、なければ既存ブランチを使う。
 * startPoint が `origin/<ref>` 形式なら remote-tracking ref をローカルに用意するため先行で
 * `git fetch origin <ref>` を実行する（PR picker は GitHub 直問い合わせの head ref を渡すため、
 * ローカル clone が stale な場合に必要）。
 */
export async function createWorktree(params: {
  dir: string;
  worktreeDir: string;
  branch: string;
  startPoint: string;
  /** メインリポジトリからシンボリックリンクする相対パス一覧（project 設定 worktreeSymlinks） */
  symlinks: string[];
}): Promise<WorktreeInfo> {
  const { dir, worktreeDir, branch, startPoint, symlinks } = params;
  const absPath = await ensureWorktreePath(dir, worktreeDir);
  const args = ["worktree", "add"];
  if (startPoint !== "") {
    const originPrefix = "origin/";
    if (startPoint.startsWith(originPrefix)) {
      await runGit(["fetch", "origin", startPoint.slice(originPrefix.length)], dir);
    }
    // -B: ローカルブランチが既存なら startPoint にリセット、未存在なら作成。
    // 他 worktree で checkout 中のブランチは git 側が `fatal: cannot force update ...` を
    // 返すのでそのまま throw して呼び出し側の notify.error に stderr を流す
    args.push("-B", branch, "--no-track", absPath, startPoint);
  } else {
    args.push(absPath, branch);
  }
  await runGit(args, dir);
  // symlink source は main repo root 基準。dir は subdir / worktree のこともある
  // （createWorktree の dir 契約）ため、worktree 配置と同じく main root に解決してから渡す。
  const mainRepoRoot = await resolveMainRepoRoot(dir);
  createWorktreeSymlinks(mainRepoRoot, absPath, symlinks);
  const list = await worktreeList(dir);
  const resolved = realpathOrSelf(absPath);
  const entry = list.find((wt) => wt.path === absPath || realpathOrSelf(wt.path) === resolved);
  if (entry === undefined) {
    throw new Error(`worktree created but not found in list: ${absPath}`);
  }
  return entry;
}

/**
 * メインリポジトリの各 target を worktree にシンボリックリンクする。
 * `.claude/` や `.env.local` など git 管理外のローカル設定を全 worktree で共有する用途
 * （pnpm v11 の worktree ヘルパーと同じアプローチ）。
 *
 * - source（mainRepo/target）が存在しなければ skip
 * - dest（worktree/target）が既に存在すれば skip（git checkout で取得済みの可能性）
 * - target は project 設定由来の untrusted 入力なので resolveContained で `..` 脱出を無害化する
 * - ネストした target（`.config/foo`）は dest の親ディレクトリを先に作る
 * - mkdir / symlink 失敗は 1 件でも worktree 作成全体を止めないよう握って観察ログに残す
 *   （中間パスが非ディレクトリで mkdirSync が throw する端ケースでも次の target に進む）
 */
export function createWorktreeSymlinks(
  mainRepoDir: string,
  wtPath: string,
  targets: string[],
): void {
  for (const target of targets) {
    const sourcePath = resolveContained(mainRepoDir, target);
    const destPath = resolveContained(wtPath, target);
    if (sourcePath === undefined || destPath === undefined) {
      console.error(`[createWorktreeSymlinks] rejected traversal target=${target}`);
      continue;
    }
    if (!tryCatch(() => lstatSync(sourcePath)).ok) continue;
    if (tryCatch(() => lstatSync(destPath)).ok) continue;
    // mkdir と symlink は 1 つの tryCatch で握る。中間パスが非ディレクトリで mkdirSync が
    // throw しても worktree 作成全体を止めず、当該 target を skip して次へ進める。
    const linked = tryCatch(() => {
      mkdirSync(dirname(destPath), { recursive: true });
      symlinkSync(sourcePath, destPath);
    });
    if (!linked.ok) {
      console.error(
        `[createWorktreeSymlinks] symlink failed target=${target} error=${linked.error}`,
      );
    }
  }
}

/** branch が他 worktree に checkout 済みか。`git worktree add` / `-B` は他 worktree 占有中の
 * branch を拒否するため、この判定で衝突を先に検知して日付ブランチへ倒す。 */
async function isBranchCheckedOut(dir: string, branch: string): Promise<boolean> {
  return (await worktreeList(dir)).some((wt) => wt.branch === branch);
}

/** ローカルに branch が存在するか。`git rev-parse --verify --quiet refs/heads/<branch>` 相当。 */
async function localBranchExists(dir: string, branch: string): Promise<boolean> {
  const result = await tryCatch(
    runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir),
  );
  return result.ok;
}

/** 復活 worktree のブランチと startPoint を決める（createWorktree にそのまま渡す）。
 *
 * cwd（= worktree のパス）は resume の鍵なので leaf 側で固定し、ここでは branch のみ決める。
 * branch 名は resume に影響しないため、意味のある候補（ログ末尾の PR 名）を優先しつつ衝突だけ避ける:
 * - candidate 空 / 他 worktree 占有 → 衝突。日付ブランチを default から新規作成
 * - candidate 既存（未占有）→ その branch に attach（startPoint 空）
 * - candidate 未存在 → default branch から candidate を新規作成 */
export async function resolveReviveBranch(
  dir: string,
  candidate: string,
): Promise<{ branch: string; startPoint: string }> {
  if (candidate === "" || (await isBranchCheckedOut(dir, candidate))) {
    return { branch: generateTimestamp(), startPoint: await resolveStartPoint(dir) };
  }
  if (await localBranchExists(dir, candidate)) {
    return { branch: candidate, startPoint: "" };
  }
  return { branch: candidate, startPoint: await resolveStartPoint(dir) };
}

/** `git worktree prune` 相当。working dir が消えた missing-but-registered な worktree 登録を掃除する。
 * revive は cwd 不在を条件に列挙するため、外部 rm-rf 済みで `git worktree prune` 未実行の path に
 * stale 登録が残っていると `git worktree add` が失敗する。add 前に prune して、gozd の
 * `git worktree remove` 経由の削除だけでなく外部 rm-rf 由来の stale 登録も同一経路で救う。 */
export function pruneWorktrees(dir: string): Promise<void> {
  return serializeRepoWrite(dir, async () => {
    await runGit(["worktree", "prune"], dir);
  });
}

/**
 * repo の worktree 登録を書き換える操作を 1 本の列に並べる。
 *
 * 実体を退避している間その登録は「実体の消えた stale 登録」に見え、`git worktree remove` も
 * `git worktree prune` もそれを消せる。消されると退避した側の git が not-a-worktree で失敗し、
 * 復帰した実体だけが登録の無いまま残る。並べる対象を削除どうしに絞ると prune がこの隙間に
 * 入れるため、登録を書く操作すべてを同じ列に置く。
 *
 * 守れるのは gozd の中だけで、ターミナルのエージェントが叩く git には届かない。
 *
 * キーは呼び出し側が渡す repo の dir そのもの。RPC は repo の root を運ぶ契約なので、同じ
 * repo への 2 つの要求は同じ文字列を持つ。
 */
const repoWrites = new Map<string, Promise<unknown>>();

function serializeRepoWrite<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = repoWrites.get(dir) ?? Promise.resolve();
  // 先行が失敗しても後続は走らせる。待ちたいのは順序であって成否ではない
  const current = previous.then(run, run);
  repoWrites.set(dir, current);
  const release = (): void => {
    if (repoWrites.get(dir) === current) repoWrites.delete(dir);
  };
  void current.then(release, release);
  return current;
}

/** rm(1) の絶対パス。PATH 上の同名コマンドではなく OS 付属のものを起動する（macOS 専用前提） */
const RM_PATH = "/bin/rm";

/**
 * 退避先の名前の接頭辞。worktree の隣に置くので、走査で gozd の退避物だと判る形にする。
 * 続く要素は退避したプロセスの id — worktree の置き場は複数インスタンスで共有されるため、
 * 掃除する側が「まだ誰かが持っている実体」を見分けられる必要がある。
 */
const TRASH_PREFIX = ".gozd-worktree-trash-";

/**
 * `git worktree remove [-f] <path>` 相当。ただし実体の unlink は待たない。
 *
 * git は worktree 配下の全エントリを unlink してから戻るため、依存ツリーやビルド成果物を抱えた
 * worktree では削除がエントリ数に比例して待たされる。rename(2) はディレクトリエントリ 1 個の
 * 更新で済むので、先に隣へ退避してから git を呼べば、UI が待つ時間は中身の量に依らず一定に
 * なる。実体の unlink は切り離した子プロセスへ渡す。
 *
 * git は worktree の実体が無くても not-a-worktree / main worktree / locked / validate を判定し、
 * 管理ファイルも消す。実体の有無で分岐するのは clean 判定と実削除だけなので、clean 判定だけを
 * `assertWorktreeClean` で肩代わりする。実体が無くても判定できるのは親ディレクトリが実在する
 * 場合で、git が解決を許す欠落はパス末尾の 1 要素だけ。
 */
export function removeWorktree(dir: string, path: string, force: boolean): Promise<void> {
  return serializeRepoWrite(dir, () => detachAndRemove(dir, path, force));
}

async function detachAndRemove(dir: string, path: string, force: boolean): Promise<void> {
  const trash = (await isDetachable(dir, path)) ? trashPathFor(path) : undefined;
  if (trash === undefined) {
    await runWorktreeRemove(dir, path, force);
    return;
  }
  if (!force) await assertWorktreeClean(path);
  renameSync(path, trash);
  const removed = await tryCatch(runWorktreeRemove(dir, path, force));
  if (!removed.ok) {
    // locked worktree 等、git がまだ拒否し得る。実体を元の位置へ戻してから失敗を伝える
    const restored = tryCatch(() => renameSync(trash, path));
    if (!restored.ok) {
      console.error(
        `[removeWorktree] restore failed path=${path} trash=${trash} error=${restored.error}`,
      );
    }
    throw removed.error;
  }
  discardInBackground([trash]);
}

async function runWorktreeRemove(dir: string, path: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("-f");
  args.push(path);
  await runGit(args, dir);
}

/**
 * 実体を切り離してよい対象か。git も登録の有無と main worktree を実体に依らず判定するが、
 * その判定は rename の後になる。切り離した実体を戻せなかったとき失うものが大きいので、
 * 動かす前に同じ問いをここで解く。false の対象は git がそのまま拒否する。
 */
async function isDetachable(dir: string, path: string): Promise<boolean> {
  // git は登録を realpath で持つため、symlink を含むパスで呼ばれると文字列一致では拾えない
  // （macOS の `$TMPDIR` が `/private/var` の symlink になっているのが典型）
  const resolved = realpathOrSelf(path);
  const entry = (await worktreeList(dir)).find(
    (wt) => wt.path === path || realpathOrSelf(wt.path) === resolved,
  );
  return entry !== undefined && !entry.isMain;
}

/**
 * 実体の退避先となる一意なパス。実体が既に無ければ undefined を返し、呼び出し側は git に
 * 登録の掃除ごと任せる。
 *
 * 退避先を worktree の兄弟に取るのは、`rename(2)` がファイルシステムを跨げないため。同じ
 * ディレクトリに置けば跨ぎようがなく、退避できない配置が存在しなくなる。
 */
function trashPathFor(path: string): string | undefined {
  if (!tryCatch(() => lstatSync(path)).ok) return undefined;
  return join(dirname(path), `${TRASH_PREFIX}${process.pid}-${randomUUID()}`);
}

/**
 * 失われて困るものを持つ worktree で throw する。git の check_clean_worktree 相当を、実体を
 * 退避する前に肩代わりする（退避後の git はこの判定に到達できない）。
 *
 * submodule の判定は git の validate_no_submodules と同じく 2 段。worktree の git dir に
 * `modules` があれば、working tree 側が deinit 済みでも拒否する — そこには submodule の
 * object store が入っており、worktree の管理ファイルごと消えるため。`modules` が無ければ
 * 展開済みの submodule を探す（`submodule status` の先頭 `-` は未初期化を表す）。
 */
async function assertWorktreeClean(path: string): Promise<void> {
  const gitDir = await perWorktreeGitDir(path);
  const modules = tryCatch(() => statSync(join(gitDir, "modules")).isDirectory());
  const hasModules = modules.ok && modules.value;
  const submodules = hasModules ? "" : await runGit(["submodule", "status"], path);
  if (hasModules || submodules.split("\n").some((line) => line !== "" && !line.startsWith("-"))) {
    throw new Error(`'${path}' contains submodules`);
  }
  const status = await runGit(["status", "--porcelain", "--ignore-submodules=none"], path);
  if (status.trim() !== "") {
    throw new Error(`'${path}' contains modified or untracked files`);
  }
}

/**
 * 渡された実体を切り離した子プロセスに unlink させる。エントリ数に比例する時間を main の
 * event loop にも libuv の threadpool にも載せないため、in-process の `fs.rm` ではなく別プロセスに
 * 渡す。切り離してあるのでアプリを終了しても削除は完走する。
 *
 * 取り消せない操作なので、対象は 1 行 1 パスで記録してから起動する。exit code を見るのは
 * 権限や I/O エラーで rm が非 0 終了する経路が silent drop になるため。stderr を pipe すると
 * 親の終了後に子が EPIPE を踏むので、観測は exit code で行う。親より後に起きた失敗は
 * 原理的に観測できない。
 */
function discardInBackground(trashes: string[]): void {
  console.error(`[discardInBackground] discarding:\n${trashes.join("\n")}`);
  const child = spawn(RM_PATH, ["-rf", ...trashes], { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    console.error(`[discardInBackground] spawn failed error=${error}`);
  });
  child.on("exit", (code, signal) => {
    if (code === 0) return;
    console.error(`[discardInBackground] failed exit=${code} signal=${signal}`);
  });
  child.unref();
}

/** dir 直下のディレクトリ名。読めない dir は観察ログに残して空として扱う */
function listSubdirNames(dir: string): string[] {
  const result = tryCatch(() => readdirSync(dir, { withFileTypes: true }));
  if (!result.ok) {
    // root 不在は初回起動の正常系。それ以外は掃除が黙って止まる原因になるので残す
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) console.error(`[listSubdirNames] cannot read dir=${dir} ${result.error}`);
    return [];
  }
  return result.value.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** 退避物の名前から所有プロセスの id を取り出す。読めない形なら undefined */
function trashOwnerPid(entryName: string): number | undefined {
  if (!entryName.startsWith(TRASH_PREFIX)) return undefined;
  const [pidText = ""] = entryName.slice(TRASH_PREFIX.length).split("-");
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** そのプロセスが生きているか。EPERM は「居るが触れない」なので生存側 */
function isProcessAlive(pid: number): boolean {
  const result = tryCatch(() => process.kill(pid, 0));
  if (result.ok) return true;
  return (result.error as NodeJS.ErrnoException).code === "EPERM";
}

/**
 * 掃除してよい退避物の絶対パスを集める。走査するのは gozd が作る worktree の置き場だけ
 * （外部で作られた worktree は任意の場所にあり、走査すべき範囲を決められない）。
 *
 * 所有プロセスが生きているものは飛ばす。worktree の置き場は複数インスタンスで共有され、
 * 別インスタンスが退避している最中の実体を消すと、そのインスタンスが復帰させたい worktree の
 * 中身が欠ける。id が再利用されて生存と誤判定しても、消さずに次の起動へ送るだけで済む。
 */
export function collectWorktreeTrash(root: string): string[] {
  return listSubdirNames(root).flatMap((project) =>
    listSubdirNames(join(root, project))
      .filter((entry) => {
        const pid = trashOwnerPid(entry);
        return pid !== undefined && !isProcessAlive(pid);
      })
      .map((entry) => join(root, project, entry)),
  );
}

/**
 * 前回までの実行が消し切れなかった退避物を掃除する。rename から `rm` の起動までの間に
 * プロセスが落ちると、実体は名前だけ変わってその場に残る。
 *
 * 1 プロセスにまとめて渡すので、残骸の数が増えても起動時に走る `rm` は 1 つ。
 */
export function sweepWorktreeTrash(): void {
  const trashes = collectWorktreeTrash(gozdWorktreesRoot());
  if (trashes.length === 0) return;
  discardInBackground(trashes);
}

/** C0 制御文字（< 0x20）と DEL（0x7f）を含むか。for-of は code point 単位で走査する */
function hasControlChar(s: string): boolean {
  for (const char of s) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * worktree の leaf 名として使えるか。
 *
 * - 1 path component のみ許可する。`/`, `.`, `..`, 制御文字は base 配下からの逸脱や、
 *   ファイル API への橋渡しでの予期しない扱いを招く
 * - 退避物の接頭辞で始まる名前も拒否する。掃除はこの接頭辞だけを頼りに消す対象を決めるため、
 *   worktree が同じ名前を取れると起動時に消される
 */
export function isValidWorktreeLeaf(leaf: string): boolean {
  return (
    leaf !== "" &&
    !leaf.includes("/") &&
    leaf !== "." &&
    leaf !== ".." &&
    !hasControlChar(leaf) &&
    !leaf.startsWith(TRASH_PREFIX)
  );
}

/**
 * `~/.local/share/gozd/worktrees/<projectKey>/<leaf>` の絶対パスを返し、親ディレクトリを作成する。
 */
async function ensureWorktreePath(projectDir: string, leaf: string): Promise<string> {
  if (!isValidWorktreeLeaf(leaf)) {
    throw new Error(`invalid worktree leaf name: ${leaf}`);
  }
  const projectKey = await resolveProjectKey(projectDir);
  const base = join(gozdWorktreesRoot(), projectKey);
  mkdirSync(base, { recursive: true });
  return join(base, leaf);
}

function realpathOrSelf(path: string): string {
  const result = tryCatch(() => realpathSync(path));
  return result.ok ? result.value : path;
}
