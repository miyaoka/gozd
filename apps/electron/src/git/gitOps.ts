// git RPC op。Swift 版 `GitOps+Worktree.swift` / `GitOps+Status.swift` /
// `GitOps+Branch.swift` の対応物。parser は `porcelain.ts` に分離してある。

import { tryCatch } from "@gozd/shared";
import { statSync } from "node:fs";
import { join } from "node:path";
import { GitCommandError, runGit, runGitNonInteractive, runGitWithStdin } from "./gitRunner";
import {
  parsePorcelainV2WithBranch,
  parseWorktreePorcelain,
  type StatusFull,
  type WorktreeInfo,
} from "./porcelain";

/** `git worktree list --porcelain` 相当 */
export async function worktreeList(dir: string): Promise<WorktreeInfo[]> {
  return parseWorktreePorcelain(await runGit(["worktree", "list", "--porcelain"], dir));
}

/**
 * status + HEAD + upstream + ahead/behind を 1 セットで取得する。
 * `--untracked-files=all` は untracked ディレクトリ配下も個別列挙させるため必須
 * （外すと git が `dir/` のように親ディレクトリ 1 エントリに畳む）
 */
export async function gitStatusFull(dir: string): Promise<StatusFull> {
  const stdout = await runGit(
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    dir,
  );
  const parsed = parsePorcelainV2WithBranch(stdout);
  return { ...parsed, latestMtime: latestMtimeOf(dir, Object.keys(parsed.statuses)) };
}

/**
 * relPaths のうち gitignore で無視されるものを Set で返す。
 *
 * `git check-ignore --stdin -z` を使い、stdin に NUL 区切りでパスを流す。
 * 出力も NUL 区切りで「無視されたパス」だけが返る。1 fork で全件まとめて判定できる。
 * - dir 配下が git 管理されていない / git が無い場合は空 Set を返す（throw しない）
 * - 入力空なら git を起動せず即時空 Set を返す
 */
export async function checkIgnore(dir: string, relPaths: string[]): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set();
  const stdin = relPaths.map((path) => `${path}\0`).join("");
  const result = await tryCatch(
    runGitWithStdin(["check-ignore", "--stdin", "-z"], dir, stdin, {
      treatNonZeroExitAsSuccess: true,
    }),
  );
  // not a git repo / no .gitignore 等は exit code != 0。無視されたパス無しとして扱う
  if (!result.ok) return new Set();
  return new Set(result.value.split("\0").filter((path) => path !== ""));
}

/** index 1 行の先頭に立つ gitlink の mode。この mode を持つ entry が submodule。 */
const GITLINK_MODE = "160000";

/**
 * 表示に採用する index stage と、その優先度（大きいほうが勝つ）。
 *
 * 通常の entry は stage 0 だけを持つ。conflict 中の gitlink は stage 1（base）/ 2（ours）/
 * 3（theirs）が並ぶが、working tree に checkout されているのは ours なので、表示もそれに揃える。
 * base / theirs は working tree のどこにも現れない値なので採用しない。
 */
const GITLINK_STAGE_RANK: Record<string, number> = { "0": 2, "2": 1 };

/**
 * `dir` 直下の submodule を「entry 名 → 指している commit hash」の Map で返す。
 *
 * 判定の SSOT は **index の gitlink**（mode `160000`）に置く。submodule の working tree は
 * 未初期化なら中身の無いディレクトリで、初期化済みでも `.git` は readDir が除外する gitlink
 * ファイルなので、ディスク側には初期化状態に依存しない手がかりが存在しない。`.gitmodules` は
 * 「設定」であって実体ではなく、index に gitlink が無い記述も、記述の無い gitlink もあり得る。
 *
 * 引数は同ファイルの他の op（worktree root を受ける `dir`）と違い **列挙しているディレクトリ
 * そのもの**。pathspec を cwd 固定の `:(glob)*` に保つことで、ディレクトリ名がパターンとして
 * 解釈される経路を構造的に無くしている（`:(glob)<name>/*` の形にすると、`app/[slug]` のように
 * ディレクトリ名が glob メタ文字を含む場合に文字クラスとして解釈され、兄弟ディレクトリの gitlink を
 * 拾いつつ本物を取り逃す）。`:(glob)` は `*` が `/` を跨がなくなる効果を持つため、これで 1 階層に閉じる。
 *
 * anchor は cwd を所有する repo なので、worktree 内に独立した nested repo があればその index を
 * 見る（ツリーが写しているディスクの実体としては妥当）。
 *
 * - `git ls-files --stage -z` の 1 レコードは `<mode> SP <object> SP <stage> TAB <path>`
 * - 出力 path は cwd 相対。1 階層 pathspec なので `/` を含まず、そのまま entry 名になる
 * - git 管理外 / git 不在は空 Map を返す（checkIgnore と同じく throw しない）
 */
export async function listGitlinks(listDir: string): Promise<Map<string, string>> {
  const result = await tryCatch(runGit(["ls-files", "--stage", "-z", "--", ":(glob)*"], listDir));
  if (!result.ok) {
    logGitlinkFailure(listDir, result.error);
    return new Map();
  }
  const ranked = new Map<string, { hash: string; rank: number }>();
  for (const record of result.value.split("\0")) {
    if (!record.startsWith(`${GITLINK_MODE} `)) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) continue;
    const [, hash = "", stage = ""] = record.slice(0, tabIndex).split(" ");
    const rank = GITLINK_STAGE_RANK[stage];
    if (rank === undefined || hash === "") continue;
    const name = record.slice(tabIndex + 1);
    const current = ranked.get(name);
    if (current !== undefined && current.rank >= rank) continue;
    ranked.set(name, { hash, rank });
  }
  return new Map(Array.from(ranked, ([name, { hash }]) => [name, hash]));
}

/**
 * gitlink 列挙の失敗を観察可能にする。失敗の帰結は「submodule が普通のディレクトリとして出る」で、
 * 無音だと表示が退行したことに気づけない。
 *
 * 非 git プロジェクト（gozd は git 管理外の project も開ける）は列挙のたびに必ず失敗するので、
 * これを黙らせるために exit 128 を除外する。ただし 128 は git の**汎用 fatal** で not-a-repo 専用
 * ではないため、index 破損のような本物の障害もここで無音になる。stderr 文字列で絞る案は取らない:
 * git のメッセージは翻訳対象で、`gozdGitEnv` はユーザーの locale をそのまま継承するため。
 */
function logGitlinkFailure(listDir: string, error: unknown): void {
  if (error instanceof GitCommandError && error.exitCode === 128) return;
  console.error(`[listGitlinks] ls-files failed: ${String(error)} dir=${listDir}`);
}

/**
 * `git fetch --all --no-write-fetch-head` を非対話 env で実行する。
 * 失敗は throw する。呼び出し側で「offline / 認証失敗等は静かに飲み込む」判断をする
 */
export async function fetchRemotes(dir: string): Promise<void> {
  await runGitNonInteractive(["fetch", "--all", "--no-write-fetch-head"], dir);
}

export interface GitDirs {
  /** `git rev-parse --git-dir` の絶対パス。
   * 通常 clone では `<repo>/.git`、worktree では `<parent>/.git/worktrees/<name>` を指す */
  perWorktreeGitDir: string;
  /** `git rev-parse --git-common-dir` の絶対パス。
   * 通常 clone では `perWorktreeGitDir` と一致。worktree では親 `<parent>/.git` を指す */
  commonGitDir: string;
}

/**
 * per-worktree git dir と common git dir の絶対パスを取る。Swift 版
 * `GitOps.gitDirs` の対応物。
 *
 * - dir が git 管理下でない場合は **undefined** を返す（git rev-parse は exit 128）。
 *   これは「git repo ではない」という事実を表す正常パスで、エラーではない。
 * - git バイナリ不在 / その他 I/O 失敗は throw する。呼び出し側で握り潰すと
 *   「worktree なのに git dir が解決できない」障害がサイレントに通常 watch に
 *   フォールバックされ、commit 反映バグが復活する。
 *
 * `git rev-parse` は NUL 区切り出力モードを持たず、複数フラグ同時指定は newline
 * 区切りで返す。改行を含む病的パスで fragile になるため、フラグを 1 つずつ別 spawn
 * して各呼び出しが単一行のみ返す形にする（Swift 版と同じ判断）
 */
export async function gitDirs(dir: string): Promise<GitDirs | undefined> {
  const result = await tryCatch(
    (async () => ({
      perWorktreeGitDir: await singleRevParse("--git-dir", dir),
      commonGitDir: await singleRevParse("--git-common-dir", dir),
    }))(),
  );
  if (result.ok) return result.value;
  // exit 128 = "not a git repository"。git の規約
  if (result.error instanceof GitCommandError && result.error.exitCode === 128) return undefined;
  throw result.error;
}

/** `git rev-parse --path-format=absolute <flag>` を 1 回 spawn し、単一行の trim 済み path を返す */
async function singleRevParse(flag: string, cwd: string): Promise<string> {
  const stdout = await runGit(["rev-parse", "--path-format=absolute", flag], cwd);
  const text = stdout.trim();
  if (text === "") throw new Error(`git rev-parse ${flag}: empty output`);
  return text;
}

// ref store の内容ダイジェスト。FSWatchRegistry が「ref store が動いた」path 候補を検知した
// とき、実際に local (refs/heads) / remote-tracking (refs/remotes) / current HEAD のどれが
// 動いたかを内容で判定するために使う。path 白名簿で分類すると reftable backend（local /
// remote / HEAD が 1 つのバイナリテーブル群に同居し `.git/HEAD` は凍結スタブ）で判別不能に
// なるため、`git for-each-ref` / `git symbolic-ref` の内容比較で backend 非依存に判定する。
export interface RefDigest {
  /** `refs/heads/*` の `(oid, refname)` 一覧を畳んだ文字列。branch 作成 / 削除 / rename /
   * commit による OID 進行で変化する */
  heads: string;
  /** `refs/remotes/*` の一覧。push / fetch で変化する。commit では変化しない */
  remotes: string;
  /** 現在チェックアウト中の HEAD。attached なら symbolic-ref 先、detached なら
   * `detached:<oid>`。branch 切替で変化し、branch 上の commit では変化しない */
  head: string;
}

/**
 * local branch / remote-tracking / current HEAD の現在値をそれぞれ 1 つの文字列に畳んで返す。
 * `git for-each-ref` の出力は refname 昇順で決定的なので、文字列そのものを前回値と等値比較できる。
 * Swift 版 `GitOps.refDigest` の対応物。
 */
export async function refDigest(dir: string): Promise<RefDigest> {
  const stdout = await runGit(
    ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"],
    dir,
  );
  const heads: string[] = [];
  const remotes: string[] = [];
  for (const line of stdout.split("\n")) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0) continue;
    const refname = line.slice(spaceIdx + 1);
    if (refname.startsWith("refs/heads/")) {
      heads.push(line);
    } else if (refname.startsWith("refs/remotes/")) {
      remotes.push(line);
    }
  }
  return { heads: heads.join("\n"), remotes: remotes.join("\n"), head: await currentHead(dir) };
}

/**
 * 現在チェックアウト中の HEAD を返す。`symbolic-ref --quiet` は detached のとき exit 1 を
 * 返すので、それを検知して rev-parse に倒す。exit 1 以外（例: 非 git dir の 128）は本物の
 * エラーとして throw を伝播させる
 */
async function currentHead(dir: string): Promise<string> {
  const result = await tryCatch(runGit(["symbolic-ref", "--quiet", "HEAD"], dir));
  if (result.ok) return result.value.trim();
  if (result.error instanceof GitCommandError && result.error.exitCode === 1) {
    return `detached:${(await runGit(["rev-parse", "HEAD"], dir)).trim()}`;
  }
  throw result.error;
}

/**
 * relPaths を dir 基準で stat し、mtime の最大値 (Unix 秒) を返す。
 * 全 path で stat 失敗 / 入力空のとき 0。削除済みパスは stat 失敗で自然に除外される
 */
function latestMtimeOf(dir: string, relPaths: string[]): number {
  let maxTs = 0;
  for (const rel of relPaths) {
    const stat = tryCatch(() => statSync(join(dir, rel)));
    if (!stat.ok) continue;
    const ts = Math.floor(stat.value.mtimeMs / 1000);
    if (ts > maxTs) maxTs = ts;
  }
  return maxTs;
}
