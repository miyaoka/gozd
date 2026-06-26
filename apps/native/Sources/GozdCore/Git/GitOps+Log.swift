import Foundation

// log walk / merge-base / reset 系の commit ops。`git log --stdin` で N ref を 1 walk する
// `log` を中核に置き、後続 RPC (logLine / blame anchored history) が共有する `logFormat` と
// `parseLogRecords` SSOT を本ファイルに閉じる。

extension GitOps {
  /// `git log --format=<format>` の format string SSOT。`runLogStdin` / `logLine` 等の
  /// commit metadata 取得経路はすべてこの定数を使う。`parseLogRecords` が期待する 8 fields /
  /// US separator / RS terminator 構成と一対一で対応する。format を変えるなら
  /// `parseLogRecords` も同時に触ること (parse 側の field 数 / 各 field の意味と直結)。
  ///
  /// fields ( US `\u{1f}` 区切り、最後の `\u{1e}` で record 終端 ):
  /// `%H` hash / `%h` shortHash / `%P` parents / `%an` author /
  /// `%at` author date (unix epoch) / `%s` subject / `%b` body / `%D` refs
  internal static let logFormat: String =
    "%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%b%x1f%D%x1e"

  public struct LogResult: Sendable {
    public let commits: [CommitInfo]
    public let defaultBranch: String
    /// HEAD が指す branch 名 (例: `main`)。`git symbolic-ref --short HEAD` の結果。
    /// detached HEAD では空文字 (commandFailed を catch して fallback)。unborn branch
    /// (commit 無し) では branch 名がそのまま返る (porcelain v2 `# branch.head` も同じ)。
    /// renderer 側で `gitStatusChange` の `branchHead` と同一源泉から比較できるようにする。
    public let branchHead: String
  }

  public enum LogSortMode: Sendable {
    case topo
    case date
  }

  /// HEAD / `origin/<default>` / `@{upstream}` を始点に **1 回の `git log --stdin`** で walk する。
  ///
  /// 設計の根拠 (VSCode の Source Control Graph 実装 `extensions/git/src/git.ts:1444-1509` 参照):
  /// - N ref を Set で dedup して stdin に投入。git 自身が walk 中に commit を OID 単位で
  ///   dedup するので、renderer 側で merge / dedup する必要が無い
  /// - sort_mode に応じて `--topo-order` / `--date-order` を git に渡し、並び順の決定も git に任せる
  /// - 3 本並列 spawn だった旧 `logBoth` を 1 本に集約することで wall-clock を `max → 1` に削減
  ///
  /// 副次効果:
  /// `git commit --amend` / 未 push の rebase / reset 等で `origin/<branch>` が HEAD から
  /// 到達不可になっても、`@{upstream}` を始点 ref として渡すため orphan tip と祖先連鎖が
  /// visible commit set に含まれ、graph 上に `origin/<branch>` の badge が残る。
  ///
  /// エラー方針:
  /// - `commandFailed` (origin 未設定 / unborn branch / upstream 未設定 等のドメイン失敗):
  ///   defaultBranch / upstreamRef を空文字列に倒し、利用可能な ref だけで walk する
  /// - `launchFailed` (shell spawn 失敗 / hang): rethrow して上位の `notify.error` まで通す
  /// - `commandNotFound` (git CLI 未インストール): rethrow
  public static func log(
    dir: String, maxCount: UInt32, firstParentOnly: Bool, currentBranchOnly: Bool,
    sortMode: LogSortMode
  ) async throws -> LogResult {
    // defaultBranch / upstreamRef 解決を並列起動 (どちらも単発 rev-parse / symbolic-ref で短い)。
    // 並列化のメリットは小さいが本体 git log の発火タイミングを 1 回に集約するため、
    // ref 解決経路をクリティカルパスから外しておく。
    async let defaultBranchTask: String = {
      do {
        return try await defaultBranchName(dir: dir)
      } catch GitError.commandFailed {
        // origin 未設定 / `origin/HEAD` 不在の正常パス。fallback して側 stream を 1 つ落とす。
        // 「設定壊れで symbolic-ref 自体が壊れた」異常系もここに混ざるため、観察可能性として
        // stderr に 1 行残す (silent drop 禁止規律。`upstreamRefTask` 側と同じ粒度)。
        StderrLog.write(
          tag: "GitOps", "log: defaultBranchName fallback to \"\" (origin/HEAD not configured?) dir=\(dir)")
        return ""
      }
    }()
    async let upstreamRefTask: String = {
      do {
        return try await upstreamRefName(dir: dir)
      } catch GitError.commandFailed {
        // upstream 未設定 / detached HEAD / unborn branch の正常パス。fallback して
        // 側 stream を 1 つ落とす。stderr に 1 行残し「設定壊れ」「ファイル権限障害」等の
        // 異常系と区別可能にする。
        StderrLog.write(
          tag: "GitOps", "log: upstreamRefName fallback to \"\" (@{upstream} not configured?) dir=\(dir)")
        return ""
      }
    }()
    async let branchHeadTask: String = {
      do {
        return try await branchHeadName(dir: dir)
      } catch GitError.commandFailed {
        // detached HEAD は symbolic-ref が exit 128 で throw する正常パス。
        // (unborn branch はこちらに来ない: symbolic-ref --short HEAD は unborn でも
        // branch 名を exit 0 で返すため、上の do 枝に乗る。)
        // 異常系 (権限障害等) との区別のため stderr に観察ログを 1 行残す。
        StderrLog.write(
          tag: "GitOps", "log: branchHeadName fallback to \"\" (detached HEAD?) dir=\(dir)")
        return ""
      }
    }()
    // HEAD の commit OID 解決性を事前確認。unborn branch (`git init` 直後、commit 無し) では
    // HEAD が commit を指していないため、`git log --stdin` で `HEAD` を始点にすると
    // exit 128 + `fatal: bad default revision 'HEAD'` で throw する。strict 契約 (runGitWithStdin
    // の treatNonZeroExitAsSuccess=false) を維持しつつ unborn を正常系として扱うために、
    // 始点 refs から HEAD を除外する。
    async let headExistsTask: Bool = headOidExists(dir: dir)

    let defaultBranch = try await defaultBranchTask
    let upstreamRef = try await upstreamRefTask
    let branchHead = try await branchHeadTask
    let headExists = await headExistsTask

    // 始点 ref を Set dedup で集める。currentBranchOnly では HEAD のみ。
    // git 自身が walk 中に commit を OID 単位で dedup するので、ref 名重複
    // (例: fork workflow で `upstream/main` と `origin/main` が同 commit を指す等) や
    // 「upstream が origin/<default> と同じ ref」を Swift 側で skip する必要は無い。
    // Set 投入だけで足りる。
    var refs: Set<String> = []
    if headExists { refs.insert("HEAD") }
    if !currentBranchOnly {
      if !defaultBranch.isEmpty { refs.insert("origin/\(defaultBranch)") }
      if !upstreamRef.isEmpty { refs.insert(upstreamRef) }
    }

    let commits = try await runLogStdin(
      dir: dir, refs: Array(refs), maxCount: maxCount,
      firstParentOnly: firstParentOnly, sortMode: sortMode)

    let merged = try await rescueCurrentBranch(
      dir: dir, commits: commits, currentBranchOnly: currentBranchOnly, headExists: headExists,
      maxCount: maxCount, firstParentOnly: firstParentOnly, sortMode: sortMode)
    return LogResult(commits: merged, defaultBranch: defaultBranch, branchHead: branchHead)
  }

  /// 全ブランチ表示で現在ブランチ (HEAD) が結果から丸ごと欠落するケースを救済する。
  ///
  /// `currentBranchOnly == false` の walk は HEAD / `origin/<default>` / `@{upstream}` を
  /// 始点に新しい順 `maxCount` 件で切る。default ブランチに HEAD tip より新しい commit が
  /// `maxCount` 件以上あると HEAD 系統がウィンドウから押し出され、graph 上に現在ブランチが
  /// 1 行も出ない。現在ブランチが見えないと "Scroll to HEAD" / lane 0 の HEAD 予約も機能しなくなる。
  ///
  /// 救済は HEAD が結果に含まれないときだけ HEAD-only walk を 1 本足し、末尾に append する
  /// (OID dedup)。HEAD 系統は「新しい順 `maxCount` ウィンドウから押し出された」= all-refs 結果の最古
  /// commit より必ず古いため、HEAD-only walk の全 commit は all-refs 結果の全 commit より古い。
  /// よって単純 append で date / topo どちらの順序契約も保たれる (親が子より先に出ない制約も、
  /// 古い祖先側を末尾に置くので維持される)。renderer は git の返却順をそのまま行に写すため、
  /// この順序保証が描画の前提を満たす。
  ///
  /// HEAD の在否判定は parse 済み refs を見る (`%D` の `HEAD -> branch` / detached `HEAD` は
  /// `parseRefs` が `"HEAD"` 要素に展開する)。別途 `rev-parse HEAD` を spawn せず済む。
  /// `maxCount == 0` (無制限) では all-refs walk が HEAD も含めて全件返すため、この判定で
  /// 自然に false になり追加 walk は走らない。
  private static func rescueCurrentBranch(
    dir: String, commits: [CommitInfo], currentBranchOnly: Bool, headExists: Bool,
    maxCount: UInt32, firstParentOnly: Bool, sortMode: LogSortMode
  ) async throws -> [CommitInfo] {
    guard !currentBranchOnly, headExists else { return commits }
    let headPresent = commits.contains { $0.refs.contains("HEAD") }
    if headPresent { return commits }

    let headCommits = try await runLogStdin(
      dir: dir, refs: ["HEAD"], maxCount: maxCount,
      firstParentOnly: firstParentOnly, sortMode: sortMode)
    var seen = Set(commits.map { $0.hash })
    var merged = commits
    var isBoundary = true
    for commit in headCommits where !seen.contains(commit.hash) {
      // append セグメントの先頭 commit にだけ truncatedAbove を立て、renderer が
      // 最新クラスタとの境界に「途切れ行」を描けるようにする。2 件目以降は通常の commit。
      merged.append(isBoundary ? commit.withTruncatedAbove() : commit)
      seen.insert(commit.hash)
      isBoundary = false
    }
    return merged
  }

  /// `git log --stdin` で複数 ref を始点に走る単発 helper。
  ///
  /// stdin に ref 名を改行区切りで流し込む。git は各 ref を walk 始点とし、commit を OID で
  /// dedup しつつ 1 つのストリームに統合する。CLI 引数長制限の回避目的と、ref 集合を
  /// atomic に渡せる利点が `--stdin` を選ぶ理由 (VSCode `git.ts:1490-1497` の理由と同じ)。
  ///
  /// fail mode:
  /// format string は US (`\u{1f}` / `%x1f`) を field separator、RS (`\u{1e}` / `%x1e`) を
  /// record separator に使う。commit metadata 値 (`%an` / `%s` / `%b`) に US (`\u{1f}`) が
  /// 含まれた record が混ざると `parseLogRecords` の field 数チェックで `unexpectedOutput`
  /// として throw され、graph 全体が `notify.error("Failed to load git graph", ...)` に倒れる。
  /// US は ASCII 制御文字で通常テキストでは出ないが、commit message に意図的 / 偶発的に
  /// 混入する病的ケースで graph 描画が止まる trade-off。`result.commits` の SSOT 性
  /// (partial success による silent な commit 欠落の禁止) を優先し strict 契約に倒している。
  private static func runLogStdin(
    dir: String, refs: [String], maxCount: UInt32, firstParentOnly: Bool, sortMode: LogSortMode
  ) async throws -> [CommitInfo] {
    if refs.isEmpty { return [] }
    // ref 名の入力検証。`\n` を区切り子として stdin に流すため、ref 名内に CR / LF / NUL が
    // 混入していると別 ref として注入される。git の `check-ref-format` 規約上これらは
    // ref 名に許可されないので現実には起き難いが、`symbolic-ref` / `rev-parse` の出力経路を
    // 信頼せず、ここで一律弾く (silent drop 禁止規律と入力境界の一貫性のため)。
    for ref in refs {
      if ref.contains("\n") || ref.contains("\r") || ref.contains("\u{0}") {
        throw GitError.unexpectedOutput(
          "runLogStdin: ref name contains control characters (CR/LF/NUL): refusing to inject")
      }
    }
    // format / parse の SSOT は `logFormat` + `parseLogRecords`。
    // `--decorate=short` でユーザーの `log.decorate=full` 設定を上書きする。
    // full にすると %D が `refs/heads/main` / `refs/remotes/origin/main` 形式になり、
    // renderer の `r.startsWith("origin/")` / current branch 抽出が崩れる。
    var args = ["log", "--format=\(GitOps.logFormat)", "--decorate=short"]
    switch sortMode {
    case .topo: args.append("--topo-order")
    case .date: args.append("--date-order")
    }
    if maxCount > 0 { args.append("--max-count=\(maxCount)") }
    if firstParentOnly { args.append("--first-parent") }
    args.append("--stdin")
    let stdinBytes = (refs.joined(separator: "\n") + "\n").data(using: .utf8) ?? Data()
    // `treatNonZeroExitAsSuccess` は default false。git log が SIGPIPE / SIGTERM 等で
    // 「exit ≠ 0 + stderr 空」終了したケースを silent success として通さない。
    let stdout = try await runGitWithStdin(args: args, cwd: dir, stdin: stdinBytes)
    let text = String(decoding: stdout, as: UTF8.self)
    return try parseLogRecords(text)
  }

  /// `git log --format=<logFormat>` の生 stdout を CommitInfo 配列にパースする pure 関数。
  ///
  /// `logFormat` 定数と一対一で対応する。format を変えるなら同時に本関数も触ること。
  /// `runLogStdin` / `logLine` 等の commit metadata 取得経路はすべてこの parser を経由する
  /// SSOT で、parse の strict 契約 (8 fields / Int64 author date) を共通化する。
  ///
  /// throws:
  /// - `unexpectedOutput`: record の field 数が 8 でない (US 混入や git format 変更)、または
  ///   author date が Int64 として parse できない。silent skip / epoch 0 倒しにせず観察可能化する。
  internal static func parseLogRecords(_ text: String) throws -> [CommitInfo] {
    var commits: [CommitInfo] = []
    for record in text.split(separator: "\u{1e}", omittingEmptySubsequences: true) {
      let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      let parts = trimmed.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(
        String.init)
      // 8 fields: hash, shortHash, parents, author, date, subject, body, refs
      // `result.commits` が renderer の履歴 SSOT になるため、想定外フォーマットは
      // silent skip / epoch 0 倒しせず `unexpectedOutput` で throw して観察可能化する
      // (本 PR の「silent drop 禁止 / strict 契約」と整合)。
      guard parts.count == 8 else {
        throw GitError.unexpectedOutput(
          "git log record: expected 8 US-separated fields, got \(parts.count)")
      }
      let parents =
        parts[2].isEmpty
        ? [] : parts[2].split(separator: " ", omittingEmptySubsequences: true).map(String.init)
      guard let date = Int64(parts[4]) else {
        throw GitError.unexpectedOutput(
          "git log record: author date field is not Int64: \(parts[4])")
      }
      let parsedRefs = parseRefs(parts[7])
      commits.append(
        CommitInfo(
          hash: parts[0], shortHash: parts[1], parents: parents, author: parts[3], date: date,
          message: parts[5], body: parts[6], refs: parsedRefs))
    }
    return commits
  }

  /// `git log --format=%D` の出力をパースする。
  /// "HEAD -> main, origin/main, tag: v1.0" → ["HEAD", "main", "origin/main", "tag:v1.0"]
  /// "HEAD -> branch" は ["HEAD", "branch"] に分解する。renderer 側が
  /// refs.includes("HEAD") で HEAD 行を識別するため、HEAD は独立要素である必要がある。
  ///
  /// 区切り子は `, `（カンマ+スペース）固定（git の log-tree.c::format_decoration_default）。
  /// ref 名にはカンマを含めることが許されている（`git check-ref-format --branch 'foo,bar'` が
  /// 通る）ため、単純な `,` 分割は ref 名を破壊する。スペースは ref 名に含められないので
  /// `", "` 区切りなら一意にトークン化できる。
  static func parseRefs(_ refStr: String) -> [String] {
    let trimmed = refStr.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return [] }
    var result: [String] = []
    for raw in trimmed.components(separatedBy: ", ") {
      let part = raw.trimmingCharacters(in: .whitespaces)
      if part.isEmpty { continue }
      if part.hasPrefix("HEAD -> ") {
        result.append("HEAD")
        result.append(String(part.dropFirst("HEAD -> ".count)))
      } else if part.hasPrefix("tag: ") {
        result.append("tag:" + String(part.dropFirst("tag: ".count)))
      } else {
        result.append(part)
      }
    }
    return result
  }

  /// `git merge-base <hash1> <hash2>` 相当。2 commit の最低共通祖先 (merge-base) を返す。
  ///
  /// PR diff モードの起点解決に使う。GitHub の Files changed タブが採る 3-dot semantics
  /// (`<base>...<head>`) は **「merge-base(base, head) から head までの差分」** を表すが、
  /// 3-dot **構文** は両辺が commit であることを要求するため working tree を含められない。
  /// 代わりに本 RPC で merge-base OID を取り、それを `git diff <merge-base>` (右辺省略
  /// = working tree) の起点に据えることで、3-dot semantics と working tree 含有を両立する。
  ///
  /// 失敗 (history が unrelated / hash 不在等で `git merge-base` が exit 1) は **空文字** で返す。
  /// throw して error 経路に倒すこともできるが、unrelated histories は fork PR / 全削除 rebase 等の
  /// 正常入力でも起きうるため、空文字を「解決失敗」の wire 値として 1 か所に集約し呼び出し側
  /// (`usePrDiffToggleStore.enable()`) で notify.error + 状態据え置きで扱う。
  /// `validateRev` 失敗 (`-` 始まり等の option 注入 / 非 hex) も同 wire 値に倒す + stderr に
  /// 観察可能ログを残す (CLAUDE.md `silent drop は禁止` 規律、`revReachable` と同型)。
  public static func mergeBase(dir: String, hash1: String, hash2: String) async -> String {
    do {
      try validateRev(hash1)
      try validateRev(hash2)
    } catch {
      StderrLog.write(
        tag: "GitOps",
        "mergeBase: invalid rev: hash1='\(hash1)' hash2='\(hash2)': \(error)")
      return ""
    }
    do {
      let stdout = try await runGit(args: ["merge-base", hash1, hash2], cwd: dir)
      return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
    } catch {
      return ""
    }
  }

  /// 指定 rev (commit OID) が local repo に reachable か。`git cat-file -e <hash>` 相当。
  ///
  /// PR diff toggle ON 時に base OID が未 fetch かを判定し、fetch 要求 (`useRemoteFetchSync`
  /// 経由) を必要最小限に絞るために使う。reachable=false でも throw せず bool で返す契約に
  /// することで、呼び出し側は「git failure」と「reachable でないだけ」を構造的に区別できる。
  ///
  /// `validateRev` 失敗 (`-` 始まり等の option 注入 / 非 hex) は false に倒すが、これは
  /// 「reachable でない」とは別レイヤの input bug なので stderr に観察可能ログを残す
  /// (CLAUDE.md `silent drop は禁止` 規律)。
  public static func revReachable(dir: String, hash: String) async -> Bool {
    do {
      try validateRev(hash)
    } catch {
      StderrLog.write(tag: "GitOps", "revReachable: invalid rev '\(hash)': \(error)")
      return false
    }
    do {
      _ = try await runGit(args: ["cat-file", "-e", hash], cwd: dir)
      return true
    } catch {
      return false
    }
  }

  /// active worktree の現在 branch を指定コミットへ `git reset --mixed <hash>` で移動する。
  ///
  /// `--mixed` は branch ref を <hash> に動かし index を <hash> に reset するが working tree の
  /// ファイルは書き換えない。git-graph の commit 行の右クリックメニューから呼ぶ。
  ///
  /// hash は `lsTree` と同じ規律で検証する: 空文字 / all-zero hex (UNCOMMITTED_HASH) を reject し、
  /// `validateRev` で `-` 始まり (option 注入) / 非 hex を弾く。working tree への reset は意味を
  /// 持たないため renderer は commit 行以外でこの RPC を呼ばない契約だが、入口で構造的に守る。
  public static func resetMixed(dir: String, hash: String) async throws {
    if hash.isEmpty {
      throw GitError.unexpectedOutput("git reset: hash must be specified")
    }
    if isAllZeroHex(hash) {
      throw GitError.unexpectedOutput(
        "git reset: all-zero hash (UNCOMMITTED_HASH) is not a valid commit")
    }
    try validateRev(hash)
    // `--` で hash を pathspec から分離し、option / pathspec 誤解釈の余地を残さない。
    _ = try await runGit(args: ["reset", "--mixed", hash, "--"], cwd: dir)
  }
}
