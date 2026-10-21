// log walk / merge-base / reset 系の commit ops。
// `git log --stdin` で N ref を 1 walk する `log` を中核に置き、後続 RPC（logLine / blame
// anchored history）が共有する `LOG_OUTPUT_ARGS` と `parseLogRecords` SSOT を本ファイルに閉じる。

import type { BranchScope, GitCommitSignature } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import {
  allBranchRefs,
  branchHeadName,
  defaultBranchName,
  headOidExists,
  upstreamRefName,
} from "./gitBranch";
import { runGit, runGitWithStdin } from "./gitRunner";
import { isAllZeroHex, validateRev } from "./gitValidate";

/**
 * `git log` の出力指定 SSOT。commit metadata 取得経路はすべて、親の読み方（`ParentSource`）に
 * 対応する引数を使い、同じ `ParentSource` を渡した `parseLogRecords` で出力を読む。
 *
 * `--format` ではなく raw 出力にするのは、署名ヘッダ（`gpgsig`）を検証抜きに出せる
 * placeholder が `--format` に無いため。`%G?` 系はどれも署名ごとに gpg / ssh-keygen を起動して
 * 検証し、鍵や `gpg.ssh.allowedSignersFile` が手元に無いと署名済みでも `N` / `E` を返す。
 *
 * - `--decorate=short`: ユーザーの `log.decorate=full` を上書きする。full だと ref が
 *   `refs/heads/main` 形式になり、renderer の `startsWith("origin/")` / current branch 抽出が崩れる
 * - `--no-show-signature`: ユーザーの `log.showSignature` を上書きする。有効だと検証結果の行が
 *   raw 出力に混ざる
 * - `--no-color`: ユーザーの `color.ui=always` を上書きする。有効だと commit 行に色の制御文字が入る
 */
const RAW_OUTPUT_ARGS = ["--pretty=raw", "--decorate=short", "--no-show-signature", "--no-color"];

/**
 * commit の親をどこから読むか。
 *
 * - `commitLine`: `--parents` が commit 行に出す親。shallow clone の境界では空になり（旧 `%P` と同じ）、
 *   graph が手元に無い親へ線を伸ばさない。pathspec を伴う log に `--parents` を付けると親の書き換えで
 *   並びが変わるため、pathspec の無い graph の walk だけが使う
 * - `header`: raw 出力の `parent` ヘッダ。grafts や shallow を考慮しない本来の親
 */
export type ParentSource = "commitLine" | "header";

/** 親の読み方ごとの `git log` の出力指定。`commitLine` は `--parents` が無いと親が空になる */
export const LOG_OUTPUT_ARGS: Record<ParentSource, string[]> = {
  commitLine: [...RAW_OUTPUT_ARGS, "--parents"],
  header: RAW_OUTPUT_ARGS,
};

/** 短縮 hash の桁数。graph の行に出す目印で、完全な hash はコミット詳細に出る */
const SHORT_HASH_LENGTH = 7;

export interface CommitInfo {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: number;
  message: string;
  body: string;
  refs: string[];
  /** 直上で履歴が途切れている（上の行と連続しない別セグメントの先頭）行か。
   * 全ブランチ表示で HEAD が窓から押し出され HEAD-only walk を append した境界の
   * 先頭 commit にだけ true が立つ */
  truncatedAbove: boolean;
  signature: GitCommitSignature;
}

export interface LogResult {
  commits: CommitInfo[];
  defaultBranch: string;
  /** HEAD が指す branch 名。detached HEAD では空文字 */
  branchHead: string;
}

type LogSortMode = "topo" | "date";

export interface LogParams {
  dir: string;
  maxCount: number;
  firstParentOnly: boolean;
  branchScope: BranchScope;
  sortMode: LogSortMode;
}

/**
 * HEAD / `origin/<default>` / `@{upstream}` を始点に **1 回の `git log --stdin`** で walk する。
 *
 * 設計の根拠（VSCode の Source Control Graph 実装 `extensions/git/src/git.ts` 参照）:
 * - N ref を Set で dedup して stdin に投入。git 自身が walk 中に commit を OID 単位で
 *   dedup するので、renderer 側で merge / dedup する必要が無い
 * - sort mode に応じて `--topo-order` / `--date-order` を git に渡し、並び順の決定も git に任せる
 *
 * 副次効果: `git commit --amend` / 未 push の rebase 等で `origin/<branch>` が HEAD から
 * 到達不可になっても、`@{upstream}` を始点 ref として渡すため orphan tip と祖先連鎖が
 * visible commit set に含まれ、graph 上に badge が残る。
 *
 * エラー方針:
 * - GitCommandError（origin 未設定 / unborn branch / upstream 未設定 等のドメイン失敗）:
 *   defaultBranch / upstreamRef を空文字列に倒し、利用可能な ref だけで walk する
 * - spawn 失敗（git CLI 不在等）: rethrow して上位の notify.error まで通す
 */
export async function log(params: LogParams): Promise<LogResult> {
  const { dir, maxCount, firstParentOnly, branchScope, sortMode } = params;
  // ref 解決を並列起動。fallback は正常パスだが「設定壊れ」等の異常系と区別できるよう
  // stderr に 1 行残す（silent drop 禁止規律）
  const [defaultBranchResult, upstreamRefResult, branchHeadResult, headExists] = await Promise.all([
    tryCatch(defaultBranchName(dir)),
    tryCatch(upstreamRefName(dir)),
    tryCatch(branchHeadName(dir)),
    headOidExists(dir),
  ]);
  const defaultBranch = fallbackEmpty(
    defaultBranchResult,
    `log: defaultBranchName fallback to "" (origin/HEAD not configured?) dir=${dir}`,
  );
  const upstreamRef = fallbackEmpty(
    upstreamRefResult,
    `log: upstreamRefName fallback to "" (@{upstream} not configured?) dir=${dir}`,
  );
  const branchHead = fallbackEmpty(
    branchHeadResult,
    `log: branchHeadName fallback to "" (detached HEAD?) dir=${dir}`,
  );

  // 始点 ref を Set dedup で集める。branchScope で範囲を決める。
  // unborn branch（HEAD が commit を指さない）では HEAD を始点にすると exit 128 で
  // throw するため、始点 refs から HEAD を除外する
  const refs = new Set<string>();
  if (headExists) refs.add("HEAD");
  if (branchScope === "default") {
    if (defaultBranch !== "") refs.add(`origin/${defaultBranch}`);
    if (upstreamRef !== "") refs.add(upstreamRef);
  } else if (branchScope === "all") {
    // ローカル / リモート全ブランチ ref を始点に投入。git 自身が walk 中に OID dedup するため
    // renderer 側の merge は不要（default モードと同じ walk 契約）。
    for (const ref of await allBranchRefs(dir)) refs.add(ref);
  }

  const commits = await runLogStdin(dir, [...refs], maxCount, firstParentOnly, sortMode);
  const merged = await rescueCurrentBranch(
    dir,
    commits,
    branchScope,
    headExists,
    maxCount,
    firstParentOnly,
    sortMode,
  );
  return { commits: merged, defaultBranch, branchHead };
}

function fallbackEmpty(
  result: { ok: true; value: string } | { ok: false; error: unknown },
  note: string,
): string {
  if (result.ok) return result.value;
  console.error(`[GitOps] ${note}`);
  return "";
}

/**
 * 全ブランチ表示で現在ブランチ（HEAD）が結果から丸ごと欠落するケースを救済する。
 *
 * default ブランチに HEAD tip より新しい commit が maxCount 件以上あると HEAD 系統が
 * ウィンドウから押し出され、graph 上に現在ブランチが 1 行も出ない。HEAD が結果に含まれない
 * ときだけ HEAD-only walk を 1 本足し、末尾に append する（OID dedup）。HEAD 系統は
 * all-refs 結果の全 commit より必ず古いため、単純 append で date / topo どちらの順序契約も
 * 保たれる。append セグメントの先頭 commit にだけ truncatedAbove を立て、renderer が
 * 最新クラスタとの境界に「途切れ行」を描けるようにする。
 */
async function rescueCurrentBranch(
  dir: string,
  commits: CommitInfo[],
  branchScope: BranchScope,
  headExists: boolean,
  maxCount: number,
  firstParentOnly: boolean,
  sortMode: LogSortMode,
): Promise<CommitInfo[]> {
  // "current" は始点が HEAD のみで押し出しが起きないため救済不要。"default" / "all" のみ対象。
  if (branchScope === "current" || !headExists) return commits;
  // HEAD の在否判定は parse 済み refs を見る（%D の `HEAD -> branch` / detached `HEAD` は
  // parseRefs が "HEAD" 要素に展開する）。maxCount == 0（無制限）では all-refs walk が
  // HEAD も含めて全件返すため自然に false になり追加 walk は走らない
  const headPresent = commits.some((commit) => commit.refs.includes("HEAD"));
  if (headPresent) return commits;

  const headCommits = await runLogStdin(dir, ["HEAD"], maxCount, firstParentOnly, sortMode);
  const seen = new Set(commits.map((commit) => commit.hash));
  const merged = [...commits];
  let isBoundary = true;
  for (const commit of headCommits) {
    if (seen.has(commit.hash)) continue;
    merged.push(isBoundary ? { ...commit, truncatedAbove: true } : commit);
    seen.add(commit.hash);
    isBoundary = false;
  }
  return merged;
}

/**
 * `git log --stdin` で複数 ref を始点に走る単発 helper。
 *
 * stdin に ref 名を改行区切りで流し込む。CLI 引数長制限の回避と、ref 集合を atomic に
 * 渡せる利点が `--stdin` を選ぶ理由。
 *
 * fail mode: 想定外の形の record は `parseLogRecords` が throw し、graph 全体が
 * notify.error に倒れる。`result.commits` の SSOT 性（partial success による silent な
 * commit 欠落の禁止）を優先し strict 契約に倒す。
 */
async function runLogStdin(
  dir: string,
  refs: string[],
  maxCount: number,
  firstParentOnly: boolean,
  sortMode: LogSortMode,
): Promise<CommitInfo[]> {
  if (refs.length === 0) return [];
  // ref 名の入力検証。`\n` を区切り子として stdin に流すため、ref 名内に CR / LF / NUL が
  // 混入していると別 ref として注入される。`symbolic-ref` / `rev-parse` の出力経路を信頼せず
  // ここで一律弾く
  for (const ref of refs) {
    if (ref.includes("\n") || ref.includes("\r") || ref.includes("\0")) {
      throw new Error(
        "runLogStdin: ref name contains control characters (CR/LF/NUL): refusing to inject",
      );
    }
  }
  const args = ["log", ...LOG_OUTPUT_ARGS.commitLine];
  args.push(sortMode === "topo" ? "--topo-order" : "--date-order");
  if (maxCount > 0) args.push(`--max-count=${maxCount}`);
  if (firstParentOnly) args.push("--first-parent");
  args.push("--stdin");
  // treatNonZeroExitAsSuccess は使わない。git log が SIGPIPE / SIGTERM 等で
  // 「exit ≠ 0 + stderr 空」終了したケースを silent success として通さない
  const stdout = await runGitWithStdin(args, dir, `${refs.join("\n")}\n`);
  return parseLogRecords(stdout, "commitLine");
}

/**
 * `git log <LOG_OUTPUT_ARGS[parentSource]>`（raw 出力）の生 stdout を CommitInfo 配列にパースする pure 関数。
 * commit metadata 取得経路はすべてこの parser を経由する SSOT。想定外の形は silent skip /
 * epoch 0 倒しにせず throw して観察可能化する。
 *
 * raw 出力の 1 record:
 * - `commit <hash>` 行。`--parents` なら親の hash、decorate される ref があれば ` (<refs>)` が続く
 * - ヘッダ行（`parent` / `author` / `gpgsig` 等）。値の継続行は先頭が空白
 * - 空行のあとにメッセージ。各行は 4 文字インデントされる
 *
 * メッセージの各行がインデントされるため、行頭が `commit ` の行は record の先頭に限られる。
 */
export function parseLogRecords(text: string, parentSource: ParentSource): CommitInfo[] {
  const records: string[][] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("commit ")) {
      records.push([line]);
      continue;
    }
    const current = records.at(-1);
    if (current === undefined) {
      if (line === "") continue;
      throw new Error(`git log record: unexpected line before the first commit: ${line}`);
    }
    current.push(line);
  }
  return records.map((lines) => parseRawCommit(lines, parentSource));
}

const COMMIT_LINE = /^commit ([0-9a-f]+)((?: [0-9a-f]+)*)(?: \((.*)\))?$/;

/** `<name> <<email>> <epoch> <tz>`。name は空のことがある。使うのは epoch だけなので、
 * タイムゾーンの形は問わない（fsck が警告する形の commit で log 全体を落とさない） */
const AUTHOR_VALUE = /^(.*?) ?<[^>]*> (-?\d+)(?: .*)?$/;

/** メッセージ行のインデント（git の pretty.c が raw 出力で付ける） */
const MESSAGE_INDENT = "    ";

function parseRawCommit(lines: string[], parentSource: ParentSource): CommitInfo {
  const commitMatch = COMMIT_LINE.exec(lines[0]);
  if (commitMatch === null) throw new Error(`git log record: malformed commit line: ${lines[0]}`);
  const hash = commitMatch[1];

  const headerEnd = lines.indexOf("", 1);
  const header = lines.slice(1, headerEnd === -1 ? lines.length : headerEnd);
  const headerParents: string[] = [];
  let authorValue: string | undefined;
  let signature: GitCommitSignature = "none";
  for (const line of header) {
    // 継続行（先頭が空白）はヘッダのキーを持たない
    if (line.startsWith(" ")) continue;
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    if (key === "parent") headerParents.push(value);
    else if (key === "author") authorValue = value;
    else if (SIGNATURE_HEADER_KEYS.includes(key)) {
      signature = SIGNATURE_KIND_BY_ARMOR[value] ?? "unknown";
    }
  }
  if (authorValue === undefined) throw new Error(`git log record: no author header in ${hash}`);
  const authorMatch = AUTHOR_VALUE.exec(authorValue);
  if (authorMatch === null) {
    throw new Error(`git log record: malformed author header in ${hash}: ${authorValue}`);
  }

  const messageLines = headerEnd === -1 ? [] : lines.slice(headerEnd + 1);
  // record の末尾には次の commit 行との区切りの空行が付く
  while (messageLines.at(-1) === "") messageLines.pop();
  const message = messageLines.map((line) => {
    if (!line.startsWith(MESSAGE_INDENT)) {
      throw new Error(`git log record: message line is not indented in ${hash}: ${line}`);
    }
    return line.slice(MESSAGE_INDENT.length);
  });
  const { subject, body } = splitMessage(message);
  const commitLineParents = commitMatch[2].split(" ").filter((parent) => parent !== "");

  return {
    hash,
    shortHash: hash.slice(0, SHORT_HASH_LENGTH),
    parents: parentSource === "commitLine" ? commitLineParents : headerParents,
    author: authorMatch[1],
    date: Number(authorMatch[2]),
    message: subject,
    body,
    refs: parseRefs(commitMatch[3] ?? ""),
    truncatedAbove: false,
    signature,
  };
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * メッセージを `%s` / `%b` と同じ規則で分ける。subject は先頭の空行を飛ばした最初の段落を
 * 空白 1 つで連結したもの（行頭の空白は残す）、body はその後の空行を飛ばした残り全体。body の末尾改行は
 * 付けない（raw 出力ではコミットオブジェクトが末尾改行で終わるかを区別できない）。
 */
function splitMessage(lines: string[]): { subject: string; body: string } {
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i++;
  const subjectLines: string[] = [];
  while (i < lines.length && !isBlank(lines[i])) {
    subjectLines.push(lines[i].trimEnd());
    i++;
  }
  while (i < lines.length && isBlank(lines[i])) i++;
  const rest = lines.slice(i);
  return {
    subject: subjectLines.join(" "),
    body: rest.join("\n"),
  };
}

/**
 * `--decorate=short` が commit 行に付ける ref 一覧（`%D` と同じ形）をパースする。
 * "HEAD -> main, origin/main, tag: v1.0" → ["HEAD", "main", "origin/main", "tag:v1.0"]。
 * renderer 側が refs.includes("HEAD") で HEAD 行を識別するため、HEAD は独立要素にする。
 *
 * 区切り子は `, `（カンマ+スペース）固定（git の log-tree.c::format_decoration_default）。
 * ref 名にはカンマを含められる（`git check-ref-format --branch 'foo,bar'` が通る）ため、
 * 単純な `,` 分割は ref 名を破壊する。スペースは ref 名に含められないので `", "` 区切りなら
 * 一意にトークン化できる。
 */
export function parseRefs(refStr: string): string[] {
  const trimmed = refStr.trim();
  if (trimmed === "") return [];
  const result: string[] = [];
  for (const raw of trimmed.split(", ")) {
    const part = raw.trim();
    if (part === "") continue;
    if (part.startsWith("HEAD -> ")) {
      result.push("HEAD");
      result.push(part.slice("HEAD -> ".length));
    } else if (part.startsWith("tag: ")) {
      result.push(`tag:${part.slice("tag: ".length)}`);
    } else {
      result.push(part);
    }
  }
  return result;
}

/** 署名ヘッダのキー。SHA-1 repo は `gpgsig`、SHA-256 repo は `gpgsig-sha256` */
const SIGNATURE_HEADER_KEYS = ["gpgsig", "gpgsig-sha256"];

/** 署名ブロック先頭行 → 方式。git の gpg-interface.c が方式の判別に使う armor と同じ */
const SIGNATURE_KIND_BY_ARMOR: Record<string, GitCommitSignature> = {
  "-----BEGIN PGP SIGNATURE-----": "gpg",
  "-----BEGIN PGP MESSAGE-----": "gpg",
  "-----BEGIN SSH SIGNATURE-----": "ssh",
  "-----BEGIN SIGNED MESSAGE-----": "x509",
};

/**
 * `git merge-base <hash1> <hash2>` 相当。2 commit の最低共通祖先を返す。
 *
 * PR diff モードの起点解決に使う。GitHub の 3-dot semantics（merge-base から head までの
 * 差分）は 3-dot 構文だと working tree を含められないため、merge-base OID を取って
 * `git diff <merge-base>` の起点に据える。
 *
 * 失敗（unrelated histories / hash 不在等で exit 1）は **空文字** で返す。fork PR / 全削除
 * rebase 等の正常入力でも起きうるため、空文字を「解決失敗」の wire 値として集約し呼び出し側で
 * notify する。validateRev 失敗も同 wire 値に倒す + stderr に観察ログを残す。
 */
export async function mergeBase(dir: string, hash1: string, hash2: string): Promise<string> {
  const valid = tryCatch(() => {
    validateRev(hash1);
    validateRev(hash2);
  });
  if (!valid.ok) {
    console.error(
      `[GitOps] mergeBase: invalid rev: hash1='${hash1}' hash2='${hash2}': ${valid.error}`,
    );
    return "";
  }
  const result = await tryCatch(runGit(["merge-base", hash1, hash2], dir));
  if (!result.ok) return "";
  return result.value.trim();
}

/**
 * 指定 rev (commit OID) が local repo に reachable か。`git cat-file -e <hash>` 相当。
 * reachable=false でも throw せず bool で返す契約にすることで、呼び出し側は「git failure」と
 * 「reachable でないだけ」を構造的に区別できる。validateRev 失敗は false に倒すが、input bug
 * なので stderr に観察ログを残す。
 */
export async function revReachable(dir: string, hash: string): Promise<boolean> {
  const valid = tryCatch(() => validateRev(hash));
  if (!valid.ok) {
    console.error(`[GitOps] revReachable: invalid rev '${hash}': ${valid.error}`);
    return false;
  }
  const result = await tryCatch(runGit(["cat-file", "-e", hash], dir));
  return result.ok;
}

/**
 * active worktree の現在 branch を指定コミットへ `git reset --mixed <hash>` で移動する。
 * branch ref と index を動かすが working tree のファイルは書き換えない。
 * 空文字 / all-zero hex（UNCOMMITTED_HASH）を reject し、validateRev で option 注入を弾く。
 */
export async function resetMixed(dir: string, hash: string): Promise<void> {
  if (hash === "") throw new Error("git reset: hash must be specified");
  if (isAllZeroHex(hash)) {
    throw new Error("git reset: all-zero hash (UNCOMMITTED_HASH) is not a valid commit");
  }
  validateRev(hash);
  // `--` で hash を pathspec から分離し、option / pathspec 誤解釈の余地を残さない
  await runGit(["reset", "--mixed", hash, "--"], dir);
}
