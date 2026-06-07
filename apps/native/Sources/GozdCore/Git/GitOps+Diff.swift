import Foundation

// hunk diff の生成 / line counting / 行範囲展開を担う。`git diff --no-index` で差分エンジンを
// git 本体 (xdiff、C 実装) に委譲し、結果 unified diff を `parseUnifiedDiffHunks` で
// `DiffHunkInfo[]` に変換する。`renderer` 側 jsdiff 全走査の代替で、pnpm-lock 級でも止まらない。

extension GitOps {
  /// 2 つのテキスト間の hunk 単位差分と総行数を返す。
  ///
  /// 設計判断: `git diff --no-index` を使い、差分エンジンを git 本体（xdiff、C 実装）に委譲する。
  /// renderer 側で jsdiff の `diffLines` を全文に対して回すと、`pnpm-lock.yaml` のような大ファイルで
  /// Myers LCS が O(N×M) に膨れメインスレッドが固まる。git に処理を移すことで:
  ///   - LCS は C で計算され GUI スレッドを塞がない
  ///   - 結果が hunk 単位に集約されるため、renderer は不変行を全描画せず gap を静的バーで省略表示できる
  ///   - 総行数も git の line counting 規約に揃えて返すことで、trailing バー描画と context 拡張の
  ///     絶対座標計算の SSOT を Swift に置く（renderer 側 split("\n") の二重実装を排除）
  ///
  /// 実装:
  ///   - `NSTemporaryDirectory()` 配下にユニークディレクトリを作り `a` / `b` の 2 ファイルを書き出す
  ///   - `git -c diff.algorithm=myers -c diff.renames=false -c core.autocrlf=false -c core.eol=lf
  ///     diff --no-index --no-color -U3` を実行。ユーザー global config 依存で算法 / 改行扱いが
  ///     変わると hunk 境界と renderer の line counting がずれるため、本 RPC が依存するオプションを
  ///     明示固定する
  ///   - exit code は 0 (差分なし) / 1 (差分あり) のいずれも success として扱う（>1 は通常エラー扱い）
  ///   - 出力が `Binary files ... differ` 1 行の場合は呼び出し側で UTF-8 化済みのテキストを渡している
  ///     前提が破れているサイン。`GitError.commandFailed` を投げて UI に観察可能化する
  ///   - unified diff 出力を `DiffHunkInfo` 配列に parse
  public static func diffHunks(original: String, current: String) async throws -> DiffHunksResult
  {
    let tmpRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let tmpDir = tmpRoot.appendingPathComponent("gozd-diff-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer {
      // 削除失敗は累積すると TMPDIR を圧迫するため stderr に observable に出す。
      // throw はしない（diff 結果取得自体は成功している）。
      do {
        try FileManager.default.removeItem(at: tmpDir)
      } catch {
        StderrLog.write(
          tag: "GitOps", "failed to remove diff tmp dir \(tmpDir.path): \(error)")
      }
    }

    let aURL = tmpDir.appendingPathComponent("a")
    let bURL = tmpDir.appendingPathComponent("b")
    try Data(original.utf8).write(to: aURL)
    try Data(current.utf8).write(to: bURL)

    let stdout = try await runGitDiffNoIndex(
      args: [
        "-c", "diff.algorithm=myers",
        "-c", "diff.renames=false",
        "-c", "core.autocrlf=false",
        "-c", "core.eol=lf",
        "diff", "--no-index", "--no-color", "-U3",
        "--", aURL.path, bURL.path,
      ],
      cwd: tmpDir.path
    )
    let output = String(decoding: stdout, as: UTF8.self)

    // `git diff --no-index` は NUL バイトを検知すると hunk を生成せず
    // `Binary files <a> and <b> differ` 行を返す。実際の出力は
    //   `diff --git ...` → `index ...` → `Binary files ... differ`
    // の 3 行構成で、hunks (`@@`) と混在しない仕様。renderer 側で binary 判定をすり抜けた
    // 入力が来た場合の防御線として先頭数行のみを走査して検知する。
    // 巨大 output 全体への `contains` は本 PR の目的 (大ファイル性能改善) と矛盾するため避け、
    // file header 数行で十分なことを根拠に `prefix(8)` で打ち切る。
    // silent に hunks=[] を返すと UI 上「差分なし」に見えるため unexpectedOutput で observable に倒す。
    // `commandFailed` は exitCode != 0 を含意するため流用しない (GitError.commandFailed の case コメント参照)。
    let outputHeaderLines = output.split(separator: "\n", omittingEmptySubsequences: false).prefix(
      8)
    if outputHeaderLines.contains(where: { $0.hasPrefix("Binary files ") }) {
      throw GitError.unexpectedOutput(
        "git diff --no-index reported binary content (renderer pre-filter bypassed)"
      )
    }

    let hunks = parseUnifiedDiffHunks(output)
    return DiffHunksResult(
      hunks: hunks,
      oldTotalLines: countDiffLines(original),
      newTotalLines: countDiffLines(current)
    )
  }

  /// git の line counting 規約でテキスト行数を返す。
  /// 規約: 空文字 = 0、末尾 `\n` 有り = `\n` 区切りで作られる「終端付き行」の数、
  /// 末尾 `\n` 無し = `\n` 区切りの数 + 1（最後の `\\ No newline at end of file` で参照される行）。
  public static func countDiffLines(_ text: String) -> UInt32 {
    if text.isEmpty { return 0 }
    let parts = text.split(separator: "\n", omittingEmptySubsequences: false)
    let trailing = text.hasSuffix("\n") ? 1 : 0
    return UInt32(parts.count - trailing)
  }

  /// `countDiffLines` と同じ規約で text を 1 行ずつの配列に分解する。
  /// 末尾 `\n` 有りの場合は最後の空要素を除外する (git の line counting に揃える)。
  /// 添字は 0-based。1-based の絶対座標から引くときは呼び出し側で `- 1` する。
  ///
  /// `internal` で公開する: `countDiffLines` と `expandDiffLines` の 2 つの public 関数が
  /// 内部で共有する正規化ロジックであり、外部 RPC ハンドラから直接呼ぶ用途は無い。
  /// テストからは `@testable import GozdCore` 経由で境界整合 (`split.count == count`) を検証する。
  static func splitDiffLines(_ text: String) -> [String] {
    if text.isEmpty { return [] }
    let parts = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    let trailing = text.hasSuffix("\n") ? 1 : 0
    return Array(parts.prefix(parts.count - trailing))
  }

  /// hunk-bar クリック展開用に original / current 全文から指定行範囲を切り出す。
  ///
  /// 1-based。`oldStart` / `newStart` から `lines` 行分を取得して `(oldLineNo, newLineNo, oldText, newText)`
  /// のタプル配列で返す。`countDiffLines` と同じ line counting 規約で行配列化することで、
  /// renderer 側の `text.split("\n").length` との末尾 1 行ずれを起こさない。
  ///
  /// 範囲外は silent に空文字を返さず `GitError.unexpectedOutput` を投げて observable に倒す
  /// (CLAUDE.md `fallback せずエラーにする` 規約)。
  public static func expandDiffLines(
    original: String,
    current: String,
    oldStart: UInt32,
    newStart: UInt32,
    lines: UInt32
  ) throws -> [(oldLineNo: UInt32, newLineNo: UInt32, oldText: String, newText: String)] {
    if lines == 0 { return [] }
    let oldLines = splitDiffLines(original)
    let newLines = splitDiffLines(current)
    let oldEnd = Int(oldStart) + Int(lines) - 1
    let newEnd = Int(newStart) + Int(lines) - 1
    guard oldStart >= 1, newStart >= 1, oldEnd <= oldLines.count, newEnd <= newLines.count else {
      throw GitError.unexpectedOutput(
        "expandDiffLines out of range: oldStart=\(oldStart) newStart=\(newStart) lines=\(lines) "
          + "oldTotal=\(oldLines.count) newTotal=\(newLines.count)"
      )
    }
    var result:
      [(oldLineNo: UInt32, newLineNo: UInt32, oldText: String, newText: String)] = []
    result.reserveCapacity(Int(lines))
    for k in 0..<Int(lines) {
      let oNo = Int(oldStart) - 1 + k
      let nNo = Int(newStart) - 1 + k
      result.append((
        oldLineNo: UInt32(oNo + 1),
        newLineNo: UInt32(nNo + 1),
        oldText: oldLines[oNo],
        newText: newLines[nNo]
      ))
    }
    return result
  }
}

// MARK: - unified diff parser

/// `git diff --no-index --no-color` 出力専用の unified diff parser。
///
/// 本実装は `diffHunks` の content-based 経路のみで使う。`--no-index` + `-c diff.renames=false`
/// 固定下では file header に出現する行は `diff --git` / `index ` / `--- ` / `+++ ` のみ
/// (`--no-index` でも git は ad-hoc blob hash を計算して `index <a>..<b> <mode>` を emit する。
/// rename 系 / mode 系は本 invocation 固定下で emit されない)。
/// 汎用 unified diff (`git diff <hash>..<hash>` 等) との両用にすると whitelist がぶれて
/// unexpectedSkips の計上閾値が曖昧になるため、本 parser は `--no-index` 専用と明示する。
///
/// 各 hunk は `@@ -oldStart[,oldLines] +newStart[,newLines] @@` ヘッダで始まり、
///   ` ` 行 = context
///   `-` 行 = removed (original 側のみ)
///   `+` 行 = added (current 側のみ)
///   `\` 行 = `\\ No newline at end of file` の装飾。読み飛ばす
/// で構成される。`diff --git` / `---` / `+++` ヘッダは無視する。
///
/// `oldLines` / `newLines` は count 省略時 1 として扱う（unified diff 仕様）。
func parseUnifiedDiffHunks(_ text: String) -> [DiffHunkInfo] {
  var hunks: [DiffHunkInfo] = []
  var lines = text.split(separator: "\n", omittingEmptySubsequences: false)
  // `text` が `\n` で終わる場合、split は末尾に空 Substring を 1 つ作る。これは
  // 改行終端の正規アーティファクトなので「想定外行」計上の対象から外す。
  if lines.last?.isEmpty == true {
    lines.removeLast()
  }
  // unified diff の想定外行 (file header / hunk header / 既知 marker 以外) を skip した件数。
  // 想定通り 0 のはずなので、>0 で出力された場合はパーサと git 出力の乖離として stderr に出す。
  var unexpectedSkips = 0

  var i = 0
  while i < lines.count {
    let raw = lines[i]
    guard raw.hasPrefix("@@") else {
      // `--no-index` モードで file header に出る行は `diff --git` / `index ` / `--- ` / `+++ `。
      // `--no-index` でも git は両ファイルの blob OID を計算して `index <a>..<b> <mode>` を emit する。
      // rename / mode 系は `-c diff.renames=false` 固定下では出ないため whitelist には含めない。
      // 上記以外の prefix が来たら hunk 探索中の異常 → 計上する。
      if !raw.isEmpty
        && !raw.hasPrefix("diff ") && !raw.hasPrefix("index ")
        && !raw.hasPrefix("--- ") && !raw.hasPrefix("+++ ")
      {
        unexpectedSkips += 1
      }
      i += 1
      continue
    }
    guard let header = parseHunkHeader(String(raw)) else {
      // `@@` で始まるが header 形式に合わない行は parser バグか git 出力の変化。
      StderrLog.write(tag: "GitOps", "unparseable hunk header: \(raw)")
      i += 1
      continue
    }
    var hunkLines: [DiffHunkLineInfo] = []
    i += 1
    while i < lines.count {
      let l = lines[i]
      if l.hasPrefix("@@") || l.hasPrefix("diff ") || l.hasPrefix("--- ")
        || l.hasPrefix("+++ ")
      {
        break
      }
      if l.hasPrefix("\\") {
        // `\ No newline at end of file` は装飾、無視
        i += 1
        continue
      }
      // hunk 本文中の prefix は ` ` / `+` / `-` のいずれか (unified diff 規約)。
      // 空 Substring は split による trailing empty の可能性があるが、その場合は
      // hunk 内ではなく hunk 直後の末尾位置にしか出現しない想定。
      guard let first = l.first else {
        unexpectedSkips += 1
        i += 1
        continue
      }
      let rest = String(l.dropFirst())
      let kind: DiffHunkLineKind
      switch first {
      case " ": kind = .context
      case "+": kind = .added
      case "-": kind = .removed
      default:
        unexpectedSkips += 1
        i += 1
        continue
      }
      hunkLines.append(DiffHunkLineInfo(kind: kind, text: rest))
      i += 1
    }
    hunks.append(
      DiffHunkInfo(
        oldStart: header.oldStart,
        oldLines: header.oldLines,
        newStart: header.newStart,
        newLines: header.newLines,
        lines: hunkLines
      ))
  }
  if unexpectedSkips > 0 {
    StderrLog.write(
      tag: "GitOps", "parseUnifiedDiffHunks: skipped \(unexpectedSkips) unexpected line(s)")
  }
  return hunks
}

private struct HunkHeader {
  let oldStart: UInt32
  let oldLines: UInt32
  let newStart: UInt32
  let newLines: UInt32
}

private func parseHunkHeader(_ line: String) -> HunkHeader? {
  // 例: "@@ -1,5 +1,7 @@" / "@@ -1 +1 @@" / "@@ -0,0 +1,3 @@ optional ctx"
  let pattern = #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"#
  guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
  let ns = line as NSString
  let range = NSRange(location: 0, length: ns.length)
  guard let m = re.firstMatch(in: line, range: range) else { return nil }

  // count 省略時の規約値 (unified diff 仕様)。
  // 数値部の `UInt32` 変換は失敗を default で握ると observability を奪うため
  // header parse 失敗として nil を返し、呼び出し側で stderr に出させる。
  let oldStart = UInt32(ns.substring(with: m.range(at: 1)))
  let newStart = UInt32(ns.substring(with: m.range(at: 3)))
  guard let oldStart, let newStart else { return nil }

  let oldLinesRange = m.range(at: 2)
  let newLinesRange = m.range(at: 4)
  let oldLines: UInt32
  if oldLinesRange.location == NSNotFound {
    oldLines = 1
  } else if let v = UInt32(ns.substring(with: oldLinesRange)) {
    oldLines = v
  } else {
    return nil
  }
  let newLines: UInt32
  if newLinesRange.location == NSNotFound {
    newLines = 1
  } else if let v = UInt32(ns.substring(with: newLinesRange)) {
    newLines = v
  } else {
    return nil
  }
  return HunkHeader(
    oldStart: oldStart, oldLines: oldLines, newStart: newStart, newLines: newLines)
}
