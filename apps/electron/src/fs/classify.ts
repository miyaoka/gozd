// FSEvents バッチの path 分類。Swift 版 `FSWatchRegistry.classify` の対応物。
// 「生の変更 path 列 → どの push event を発火すべきかの候補」の写像をこのファイルに閉じる。
//
// 分類は files backend (loose `refs/` + `packed-refs`) と reftable backend (Git 2.51+、
// 3.0 で default 化) の両方をトリガーとして扱う。どちらの backend でも真値は porcelain で
// 読み直すため、ここでの分類は「どの porcelain を再取得すべきか」を決める signal でしかない。
// backend の物理 layout に白名簿を焼き込むと、reftable のように layout が変わった瞬間に
// 無分類 silent drop で表示が永久に更新されなくなる（過去 root の `git switch` 反映バグの真因）。
//
// 判定優先順位:
//   (1) per-worktree git dir 配下 →
//       - `index` を gitStatusChange
//       - `HEAD` を gitStatusChange（files backend。+ main worktree / 通常 clone では head 候補も）
//       - `reftable/...` を gitStatusChange（reftable backend）
//   (2) common git dir 配下 →
//       - `refs/heads/...` を branchChange 候補（files backend）
//       - `refs/remotes/...` を gitStatusChange + remoteRefsChange 候補（files backend）
//       - `packed-refs` を branchChange + gitStatusChange + remoteRefsChange 候補
//         （local / remote のどちらが動いたかファイル名で判別できないため全候補）
//       - `reftable/...` を branchChange + gitStatusChange + remoteRefsChange 候補、root
//         (perWtSameAsCommon) では head 候補も（local / remote / HEAD が同居し判別不能）
//       - `worktrees/...` を worktreeChange（worktree 追加削除 + secondary の branch 切替。
//         構造変化を表す path 信号で、digest を経由せず即発火する）
//   (3) 作業ツリー配下（git dir 配下に該当しない場合）→ fsChange + gitStatusChange
//
// branchChange / remoteRefsChange / head 由来 worktreeChange の最終発火は dispatch 側が
// RefDigest（heads / remotes / head）の内容比較で決める。
//
// 意図的に未対応の ref 種別: `refs/tags/...`（git-graph が for-each-ref で取得しており
// `# branch.ab` の SSOT 哲学の射程外）/ `refs/stash` / `refs/notes/...`（UI 未表示）。
// これらは silent drop だが、将来 UI が表示する時に必ずここに分岐を足す。

export interface Classification {
  fsRelDirs: Set<string>;
  hasFsChange: boolean;
  hasGitStatusChange: boolean;
  hasBranchChange: boolean;
  hasRemoteRefsChange: boolean;
  hasWorktreeChange: boolean;
  /** HEAD (current branch) が動いた可能性のある候補。`.git/HEAD`（files の main worktree）/
   * 共有 `reftable/*`（reftable）など、checkout 先が変わりうる ref store event で立つ。
   * 実際に動いたかは primary watcher が RefDigest.head を内容比較して判定する */
  hasHeadChange: boolean;
}

export interface ClassifyInput {
  /** realpath 解決済みの watch dir（worktree root） */
  dir: string;
  /** `git rev-parse --git-dir` の realpath。dir が git repo でない時のみ undefined */
  perWorktreeGitDir: string | undefined;
  /** `git rev-parse --git-common-dir` の realpath。通常 clone では perWorktreeGitDir と一致 */
  commonGitDir: string | undefined;
  /** 変更イベントの絶対 path 列（1 バッチ分） */
  paths: string[];
}

export function classify(input: ClassifyInput): Classification {
  const { dir, perWorktreeGitDir, commonGitDir, paths } = input;
  const dirWithSlash = dir.endsWith("/") ? dir : `${dir}/`;

  const fsRelDirs = new Set<string>();
  let hasFsChange = false;
  let hasGitStatusChange = false;
  let hasBranchChange = false;
  let hasRemoteRefsChange = false;
  let hasWorktreeChange = false;
  let hasHeadChange = false;

  // 通常 clone では perWorktreeGitDir == commonGitDir なので、両ルールを同じ path に
  // 適用して `HEAD` と `refs/heads/` を両方拾う必要がある。
  // worktree clone では perWorktreeGitDir は commonGitDir の `worktrees/<name>/` 配下に
  // 物理的にネストする。per-wt にマッチした path に common 規則の `worktrees/...` →
  // worktreeChange を二重発火させると worktree list の変更と worktree-local な状態変化を
  // 混同するため、per-wt 規則が排他的に勝つ。
  const perWtSameAsCommon = perWorktreeGitDir === commonGitDir;

  for (const path of paths) {
    let matchedGitDir = false;

    const underPerWt = relativeUnder(path, perWorktreeGitDir);
    if (underPerWt !== undefined) {
      matchedGitDir = true;
      if (underPerWt === "HEAD") {
        hasGitStatusChange = true;
        // perWtSameAsCommon (= main worktree / 通常 clone) のときだけ headChange 候補を立てる。
        // worktreeChange を path で直接立てず head digest 経由にするのは、commit でも
        // `.git/HEAD` が touch される (mtime) ケースで誤発火しないよう「symbolic-ref 先が
        // 実際に変わったか」を内容で判定するため。secondary worktree の切替は root watcher の
        // `worktrees/...` 構造規則が worktreeChange として別途救済する。
        if (perWtSameAsCommon) {
          hasHeadChange = true;
        }
      } else if (underPerWt === "index") {
        hasGitStatusChange = true;
      } else if (underPerWt.startsWith("reftable/")) {
        // reftable backend: per-worktree の HEAD/refs はバイナリテーブルに格納され、
        // `HEAD` スタブは固定値で動かない。checkout 先が変わると `reftable/tables.list` +
        // 新テーブルが書かれるため status を取り直す。
        hasGitStatusChange = true;
      }
      // それ以外（logs/, objects/, ORIG_HEAD 等）は無視
    }
    // per-wt と common が別 dir のとき、per-wt にマッチした path には common 規則を
    // 適用しない（per-wt の方が長い prefix で具体性が高いため、そちらが排他的に勝つ）
    const applyCommonRule = perWtSameAsCommon || underPerWt === undefined;
    const underCommon = applyCommonRule ? relativeUnder(path, commonGitDir) : undefined;
    if (underCommon !== undefined) {
      matchedGitDir = true;
      if (underCommon.startsWith("worktrees/")) {
        hasWorktreeChange = true;
      } else if (underCommon.startsWith("refs/heads/")) {
        hasBranchChange = true;
      } else if (underCommon.startsWith("refs/remotes/")) {
        // push / fetch 成功でローカルの remote-tracking ref が書き換わる。
        // - gitStatusChange: current branch の `# branch.ab` (ahead/behind) を更新
        // - remoteRefsChange: current 以外のブランチの remote ref が動いた場合の
        //   git-graph 再 load トリガ
        hasGitStatusChange = true;
        hasRemoteRefsChange = true;
      } else if (underCommon === "packed-refs") {
        // pack 後は local ref と remote-tracking ref のどちらが書き換わったか
        // ファイル名から判別できないため、全 subscriber に通知する
        hasBranchChange = true;
        hasGitStatusChange = true;
        hasRemoteRefsChange = true;
      } else if (underCommon.startsWith("reftable/")) {
        // reftable backend の共有 ref ストア。local / remote / HEAD が同居し種別判別不能な
        // ため全候補を立てる（実際に動いたカテゴリは primary watcher の digest 比較で確定）。
        // reftable では `HEAD` スタブが動かないため、head 候補がここに無いと main worktree の
        // branch 切替が無分類で silent drop される。
        hasBranchChange = true;
        hasGitStatusChange = true;
        hasRemoteRefsChange = true;
        if (perWtSameAsCommon) {
          hasHeadChange = true;
        }
      }
    }

    if (matchedGitDir) continue;

    // 作業ツリー側の変更 → fsChange (+ git dir があれば gitStatusChange)。
    // commonGitDir === undefined は非 git dir の watch（例: session log dialog が監視する
    // ~/.claude/projects/）。git status の概念自体が無く、gitStatusChange を立てると
    // ファイル変更のたびに git status が exit 128 で落ちて観察ログを汚すため fsChange のみ。
    if (path !== dir && !path.startsWith(dirWithSlash)) continue;
    hasFsChange = true;
    if (commonGitDir !== undefined) hasGitStatusChange = true;
    fsRelDirs.add(relativeDir(path, dirWithSlash));
  }

  return {
    fsRelDirs,
    hasFsChange,
    hasGitStatusChange,
    hasBranchChange,
    hasRemoteRefsChange,
    hasWorktreeChange,
    hasHeadChange,
  };
}

/** path が root 配下なら root からの相対パスを返す。配下でなければ undefined。
 * `path === root` のときは `""` を返す */
function relativeUnder(path: string, root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  if (path === root) return "";
  const rootWithSlash = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(rootWithSlash)) return undefined;
  return path.slice(rootWithSlash.length);
}

/** イベントの絶対 path から、dir に対する **親ディレクトリ** の相対パスを返す。
 * `<dir>/foo/bar.txt` → `foo`。`<dir>/bar.txt` → `""`。
 * renderer の fsChange payload は影響を受けたディレクトリ単位で更新するため、
 * ファイル名は落としてディレクトリ部分のみ使う */
function relativeDir(path: string, dirWithSlash: string): string {
  const rel = path.startsWith(dirWithSlash) ? path.slice(dirWithSlash.length) : "";
  const lastSlash = rel.lastIndexOf("/");
  if (lastSlash < 0) return "";
  return rel.slice(0, lastSlash);
}
