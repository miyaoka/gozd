// git porcelain 出力の pure parser。Swift 版 `GitOps+Worktree.swift` /
// `GitOps+Status.swift` の parser 部の対応物。「生 git output → 構造化データ」の
// 写像をこのファイルに閉じる。

export interface WorktreeInfo {
  path: string;
  head: string;
  /** detached HEAD のとき undefined */
  branch: string | undefined;
  isMain: boolean;
}

export interface StatusFull {
  /** ファイル相対パス → porcelain v2 XY コード（未変更側は "."。例: ".M", "A.", "??"） */
  statuses: Record<string, string>;
  /** rename / copy エントリの 新パス → 旧パス。statuses のキーは新パスのみ持つ */
  renameOldPaths: Record<string, string>;
  head: string;
  /** `# branch.head` の値。detached HEAD は空文字。`git branch -m` は OID を変えないため
   * rename 検知の SSOT はこの値の変化 */
  branchHead: string;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  /** 変更ファイルの最終更新時刻 (Unix 秒)。parser 段階では 0、呼び出し側が stat で埋める */
  latestMtime: number;
}

/**
 * `git worktree list --porcelain` の出力をパースする。
 *
 * `prunable` 注釈付きのエントリは git にとっても解決不能な孤児（gitdir file が
 * 指す先が消滅している等）なので listing から除外する。後段の `git status` 等は
 * 必ず失敗するため、SSOT 段階で落とす。
 */
export function parseWorktreePorcelain(text: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let path: string | undefined;
  let head = "";
  let branch: string | undefined;
  let isDetached = false;
  let isPrunable = false;

  const flush = () => {
    if (path === undefined || path === "") return;
    if (isPrunable) return;
    // 最初のエントリが main worktree
    const isMain = result.length === 0;
    result.push({ path, head, branch: isDetached ? undefined : branch, isMain });
  };

  for (const line of text.split("\n")) {
    if (line === "") {
      flush();
      path = undefined;
      head = "";
      branch = undefined;
      isDetached = false;
      isPrunable = false;
      continue;
    }
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") {
      isDetached = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      isPrunable = true;
    }
  }
  flush();
  return result;
}

/** 単一スペース区切りで最大 maxParts 個に分割する。最後の要素は残り全体（path 中の
 * スペースを保持するため）。Swift の `split(separator:maxSplits:)` と同じ挙動 */
function splitFields(line: string, maxParts: number): string[] {
  const fields: string[] = [];
  let rest = line;
  while (fields.length < maxParts - 1) {
    const space = rest.indexOf(" ");
    if (space < 0) break;
    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  fields.push(rest);
  return fields;
}

/**
 * `git status --porcelain=v2 --branch -z` の NUL 区切り出力を parse する。
 *
 * - `# branch.oid <sha>` — HEAD ハッシュ。`(initial)` は空文字に正規化
 * - `# branch.head <name>` — branch 名。`(detached)` は空文字に正規化
 * - `# branch.upstream` / `# branch.ab +<ahead> -<behind>` — upstream 情報
 * - `1 XY ...` / `2 XY ...`（rename、後続 NUL 区切りで orig_path） / `u ...` / `? path`
 */
export function parsePorcelainV2WithBranch(text: string): StatusFull {
  const statuses: Record<string, string> = {};
  const renameOldPaths: Record<string, string> = {};
  let head = "";
  let branchHead = "";
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;

  const segments = text.split("\0");
  for (let i = 0; i < segments.length; i++) {
    const line = segments[i];
    if (line === "") continue;

    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length);
      head = oid === "(initial)" ? "" : oid;
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      for (const part of line.slice("# branch.ab ".length).split(" ")) {
        if (part.startsWith("+")) {
          ahead = Number(part.slice(1)) || 0;
        } else if (part.startsWith("-")) {
          behind = Number(part.slice(1)) || 0;
        }
      }
    } else if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length);
      branchHead = name === "(detached)" ? "" : name;
    } else if (line.startsWith("# ")) {
      // 将来追加される porcelain v2 ヘッダは意図的に silent drop（UI 要件が立ったら分岐を足す）
      continue;
    } else if (line.startsWith("1 ")) {
      // "1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      const fields = splitFields(line, 9);
      if (fields.length >= 9) {
        statuses[fields[8]] = fields[1];
      }
    } else if (line.startsWith("2 ")) {
      // rename/copy: "2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"、
      // 続いて NUL 区切りで <orig_path>
      const fields = splitFields(line, 10);
      let newPath: string | undefined;
      if (fields.length >= 10) {
        statuses[fields[9]] = fields[1];
        newPath = fields[9];
      }
      const origPath = segments[i + 1];
      if (origPath !== undefined) {
        if (newPath !== undefined && origPath !== "") {
          renameOldPaths[newPath] = origPath;
        }
        i++;
      }
    } else if (line.startsWith("u ")) {
      // unmerged: "u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const fields = splitFields(line, 11);
      if (fields.length >= 11) {
        statuses[fields[10]] = fields[1];
      }
    } else if (line.startsWith("? ")) {
      statuses[line.slice(2)] = "??";
    }
    // "! " (ignored) は通常 --porcelain では出ないため無視
  }

  return { statuses, renameOldPaths, head, branchHead, hasUpstream, ahead, behind, latestMtime: 0 };
}
