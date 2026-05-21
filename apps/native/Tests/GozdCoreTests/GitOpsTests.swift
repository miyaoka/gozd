import Foundation
import Testing

@testable import GozdCore

@Suite("GitOps.gitStatus")
struct GitOpsGitStatusTests {
  @Test("空の repo では entries が空")
  func emptyRepo() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries.isEmpty)
  }

  @Test("untracked ファイルは ?? として現れる")
  func untrackedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    try "hello".write(
      to: dir.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["new.txt"] == "??")
  }

  @Test("コミット済みファイルへの変更は \" M\" として現れる")
  func modifiedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    let file = dir.appendingPathComponent("a.txt")
    try "v1".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    try "v2".write(to: file, atomically: true, encoding: .utf8)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["a.txt"] == " M")
  }

  @Test("staged 新規ファイルは \"A \" として現れる")
  func stagedNewFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // 先に initial commit を作って HEAD を確立する（HEAD なしだと A の挙動が異なる）。
    try "seed".write(
      to: dir.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "seed.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    try "new".write(
      to: dir.appendingPathComponent("staged.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "staged.txt"], cwd: dir.path)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["staged.txt"] == "A ")
  }

  @Test("renamed ファイルは R で始まり new path を返す（old path は破棄）")
  func renamedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    let oldFile = dir.appendingPathComponent("old.txt")
    try "content".write(to: oldFile, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "old.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)
    try await runTestGit(args: ["mv", "old.txt", "new.txt"], cwd: dir.path)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["new.txt"]?.first == "R")
    #expect(entries["old.txt"] == nil)
  }

  @Test("git repo でない dir はエラー（exitCode != 0）")
  func notARepo() async throws {
    let tmp = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmp) }

    do {
      _ = try await GitOps.gitStatus(dir: tmp.path)
      Issue.record("expected error, got success")
    } catch let GitError.commandFailed(exitCode, stderr) {
      #expect(exitCode != 0)
      #expect(stderr.contains("not a git repository"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.parseRefs")
struct GitOpsParseRefsTests {
  @Test("空文字は空配列")
  func empty() {
    #expect(GitOps.parseRefs("") == [])
    #expect(GitOps.parseRefs("   ") == [])
  }

  @Test("HEAD -> branch を 2 要素に分解する")
  func splitsHeadArrow() {
    #expect(GitOps.parseRefs("HEAD -> main") == ["HEAD", "main"])
  }

  @Test("tag: prefix は tag: ラベルに正規化する")
  func normalizesTag() {
    #expect(GitOps.parseRefs("tag: v1.0") == ["tag:v1.0"])
  }

  @Test("HEAD / origin / tag が混在するケース")
  func mixed() {
    let input = "HEAD -> 20260510, origin/20260510, tag: v1.0, origin/HEAD"
    #expect(
      GitOps.parseRefs(input) == [
        "HEAD", "20260510", "origin/20260510", "tag:v1.0", "origin/HEAD",
      ])
  }

  @Test("detached HEAD は HEAD 単独要素になる")
  func detachedHead() {
    #expect(GitOps.parseRefs("HEAD") == ["HEAD"])
  }

  @Test("detached HEAD on tag")
  func detachedHeadOnTag() {
    #expect(GitOps.parseRefs("HEAD, tag: v1.0") == ["HEAD", "tag:v1.0"])
  }

  /// ref 名にカンマを含めることは git で合法（`git check-ref-format --branch 'foo,bar'` が exit 0）。
  /// `%D` の区切り子は `", "` 固定なので、単純な `","` split で誤分解させてはならない。
  @Test("ref 名に含まれるカンマで誤分解しない")
  func preservesCommaInRefName() {
    #expect(GitOps.parseRefs("HEAD -> foo,bar") == ["HEAD", "foo,bar"])
    #expect(
      GitOps.parseRefs("HEAD -> foo,bar, origin/foo,bar") == [
        "HEAD", "foo,bar", "origin/foo,bar",
      ])
  }
}

@Suite("GitOps.runGit large output")
struct GitOpsRunGitLargeOutputTests {
  /// pipe buffer (macOS は最大 ~64KB) を超える stdout で `runGit` が deadlock しないことを保証する。
  ///
  /// 旧実装は `Process.terminationHandler` 内で `readDataToEndOfFile()` していたため、
  /// 出力 > buffer の瞬間に子が write block → exit 不能 → terminationHandler が呼ばれない
  /// deadlock になっていた（gozd リポジトリ実体で再現していた症状）。
  @Test("64KB を超える stdout を deadlock せず読み切れる", .timeLimit(.minutes(1)))
  func largeStdoutDoesNotDeadlock() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // 100KB の本文を持つ commit を作る。`git log --format=%B` で本文を吐かせて
    // 100KB 超の stdout を確実に発生させる。
    let bigBody = String(repeating: "a", count: 100_000)
    let msgFile = dir.appendingPathComponent("msg.txt")
    try bigBody.write(to: msgFile, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["commit", "--allow-empty", "-F", "msg.txt"], cwd: dir.path)
    try? FileManager.default.removeItem(at: msgFile)

    // production 側の drain が正しく動けば自然に返る。修正前は無限 hang していた。
    let result = try await runGit(args: ["log", "--format=%B"], cwd: dir.path)

    #expect(result.count >= 100_000)
    // 大きい出力を別物にすり替えていないことを確認するため、本文の中身まで検証する
    let text = String(decoding: result, as: UTF8.self)
    #expect(text.contains(bigBody))
  }

  /// 同様の deadlock テストを `runGitWithStdin` 側にも適用する。
  /// `git check-ignore --stdin -z` は 64KB 超の path 一覧を flush できる必要がある。
  @Test("runGitWithStdin も 64KB 超の stdin / stdout で deadlock しない", .timeLimit(.minutes(1)))
  func runGitWithStdinLargeIO() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // .gitignore に 1 行のグロブを書き、check-ignore に多数のパスを流して
    // 大量の ignored path を吐かせる。
    try "*.tmp\n".write(
      to: dir.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)

    // 10000 個の `tmp/N.tmp` を NUL 区切りで作る（≈ 100KB 超）。
    let stdinBytes: Data = {
      var buf = Data()
      for i in 0..<10_000 {
        buf.append(Data("tmp/\(i).tmp\u{0}".utf8))
      }
      return buf
    }()

    let result = try await runGitWithStdin(
      args: ["check-ignore", "--stdin", "-z"], cwd: dir.path, stdin: stdinBytes)

    // ignored entry が NUL 区切りで返る。10000 件すべて返ることまで検証する。
    let nulCount = result.reduce(0) { $0 + ($1 == 0x00 ? 1 : 0) }
    #expect(nulCount == 10_000)
  }
}

@Suite("GitOps.buildNonInteractiveEnv")
struct BuildNonInteractiveEnvTests {
  @Test("GIT_TERMINAL_PROMPT は常に 0 に固定される")
  func terminalPromptForcedOff() {
    let env = buildNonInteractiveEnv(base: [:])
    #expect(env["GIT_TERMINAL_PROMPT"] == "0")
  }

  @Test("GIT_SSH_COMMAND 未設定なら `ssh -o BatchMode=yes`")
  func sshCommandDefault() {
    let env = buildNonInteractiveEnv(base: [:])
    #expect(env["GIT_SSH_COMMAND"] == "ssh -o BatchMode=yes")
  }

  @Test("既存 GIT_SSH_COMMAND は末尾に BatchMode=yes を追記して保持する")
  func sshCommandAppendsFlag() {
    let env = buildNonInteractiveEnv(base: ["GIT_SSH_COMMAND": "ssh -i /custom/key"])
    #expect(env["GIT_SSH_COMMAND"] == "ssh -i /custom/key -o BatchMode=yes")
  }

  @Test("空文字列 GIT_SSH_COMMAND は未設定扱いで ssh にフォールバックする")
  func sshCommandEmptyFallback() {
    let env = buildNonInteractiveEnv(base: ["GIT_SSH_COMMAND": ""])
    #expect(env["GIT_SSH_COMMAND"] == "ssh -o BatchMode=yes")
  }

  @Test("空白のみの GIT_SSH_COMMAND は未設定扱いで ssh にフォールバックする")
  func sshCommandWhitespaceFallback() {
    let env = buildNonInteractiveEnv(base: ["GIT_SSH_COMMAND": "   "])
    #expect(env["GIT_SSH_COMMAND"] == "ssh -o BatchMode=yes")
  }

  @Test("空白を含むカスタム ssh パスも上書きせず末尾追記する")
  func sshCommandWithSpaces() {
    let env = buildNonInteractiveEnv(base: ["GIT_SSH_COMMAND": "/path with spaces/ssh -F /cfg"])
    #expect(env["GIT_SSH_COMMAND"] == "/path with spaces/ssh -F /cfg -o BatchMode=yes")
  }

  @Test("base に渡した他の env は変更されない")
  func unrelatedEnvPreserved() {
    let env = buildNonInteractiveEnv(base: ["FOO": "bar", "GIT_OPTIONAL_LOCKS": "0"])
    #expect(env["FOO"] == "bar")
    #expect(env["GIT_OPTIONAL_LOCKS"] == "0")
  }

  @Test("base を変更せず新規 dict を返す (副作用なし)")
  func basePreservedAcrossCalls() {
    let base = ["GIT_SSH_COMMAND": "ssh -F /cfg"]
    _ = buildNonInteractiveEnv(base: base)
    #expect(base["GIT_SSH_COMMAND"] == "ssh -F /cfg")
  }
}

@Suite("GitOps.gitStatusFull")
struct GitOpsStatusFullTests {
  @Test("HEAD が指す branch 名が `branchHead` に入る")
  func branchHeadIsPopulated() async throws {
    // ユーザー報告の主因シナリオを下支えするテスト: `git branch -m` は OID を変えず
    // branch 名だけ変える。`branchHead` を payload に乗せるためには parse が値を
    // 正しく拾える必要がある。
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "seed".write(
      to: dir.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "seed.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "seed"], cwd: dir.path)

    let status = try await GitOps.gitStatusFull(dir: dir.path)
    #expect(status.branchHead == "main")
  }

  @Test("`git branch -m` 後の branchHead は新しい branch 名を返す")
  func branchHeadFollowsRename() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "seed".write(
      to: dir.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "seed.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "seed"], cwd: dir.path)
    try await runTestGit(args: ["branch", "-m", "renamed-feature"], cwd: dir.path)

    let status = try await GitOps.gitStatusFull(dir: dir.path)
    #expect(status.branchHead == "renamed-feature")
  }

  @Test("detached HEAD では branchHead は空文字")
  func branchHeadEmptyOnDetached() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "seed".write(
      to: dir.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "seed.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "seed"], cwd: dir.path)
    // HEAD を直接 commit にして detached state にする
    try await runTestGit(args: ["checkout", "--detach", "HEAD"], cwd: dir.path)

    let status = try await GitOps.gitStatusFull(dir: dir.path)
    #expect(status.branchHead == "")
  }
}

@Suite("GitOps.treeFileOID")
struct GitOpsTreeFileOIDTests {
  @Test("コミット済みファイルの blob OID を返す")
  func returnsBlobOIDForCommittedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "v1".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let oid = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD", relPath: "a.txt")
    #expect(oid != nil)
    #expect(oid?.count == 40)
  }

  @Test("root commit の `^` 解決失敗時は nil")
  func rootCommitParentReturnsNil() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "v1".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let oid = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD^", relPath: "a.txt")
    #expect(oid == nil)
  }

  @Test("未追跡 path は nil")
  func untrackedPathReturnsNil() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "v1".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let oid = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD", relPath: "nope.txt")
    #expect(oid == nil)
  }

  @Test("2 コミット間で変更されていないファイルは両端で OID が一致する")
  func sameOIDAcrossUnchangedCommits() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "kept".write(
      to: dir.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
    try "v1".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt", "b.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)
    try "v2".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "modify a"], cwd: dir.path)

    let bAtParent = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD^", relPath: "b.txt")
    let bAtHead = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD", relPath: "b.txt")
    #expect(bAtParent != nil)
    #expect(bAtParent == bAtHead)

    let aAtParent = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD^", relPath: "a.txt")
    let aAtHead = await GitOps.treeFileOID(dir: dir.path, hash: "HEAD", relPath: "a.txt")
    #expect(aAtParent != nil)
    #expect(aAtHead != nil)
    #expect(aAtParent != aAtHead)
  }
}

@Suite("GitOps.parseUnifiedDiffHunks")
struct ParseUnifiedDiffHunksTests {
  @Test("空文字列は空配列")
  func empty() {
    #expect(parseUnifiedDiffHunks("") == [])
  }

  @Test("1 hunk: 単純な置換")
  func singleHunkReplacement() {
    let diff = """
      diff --git a/a b/b
      --- a/a
      +++ b/b
      @@ -1,3 +1,3 @@
       line1
      -old
      +new
       line3
      """
    let hunks = parseUnifiedDiffHunks(diff)
    #expect(hunks.count == 1)
    let h = hunks[0]
    #expect(h.oldStart == 1)
    #expect(h.oldLines == 3)
    #expect(h.newStart == 1)
    #expect(h.newLines == 3)
    #expect(h.lines.map(\.kind) == [.context, .removed, .added, .context])
    #expect(h.lines.map(\.text) == ["line1", "old", "new", "line3"])
  }

  @Test("count 省略の hunk header は 1 行扱い")
  func singleLineHunkHeader() {
    let diff = """
      @@ -5 +7 @@
      -x
      +y
      """
    let hunks = parseUnifiedDiffHunks(diff)
    #expect(hunks.count == 1)
    #expect(hunks[0].oldStart == 5)
    #expect(hunks[0].oldLines == 1)
    #expect(hunks[0].newStart == 7)
    #expect(hunks[0].newLines == 1)
  }

  @Test("\\ No newline at end of file は装飾として skip する")
  func skipsNoNewlineMarker() {
    let diff = """
      @@ -1 +1 @@
      -old
      \\ No newline at end of file
      +new
      \\ No newline at end of file
      """
    let hunks = parseUnifiedDiffHunks(diff)
    #expect(hunks.count == 1)
    #expect(hunks[0].lines.map(\.kind) == [.removed, .added])
    #expect(hunks[0].lines.map(\.text) == ["old", "new"])
  }

  @Test("複数 hunk を順番に parse する")
  func multipleHunks() {
    let diff = """
      @@ -1,2 +1,2 @@
       a
      -b
      +B
      @@ -10,2 +10,2 @@
       c
      -d
      +D
      """
    let hunks = parseUnifiedDiffHunks(diff)
    #expect(hunks.count == 2)
    #expect(hunks[0].oldStart == 1)
    #expect(hunks[1].oldStart == 10)
  }

  @Test("file header 行は無視する")
  func ignoresFileHeaders() {
    let diff = """
      diff --git a/tmp/x/a b/tmp/x/b
      --- a/tmp/x/a
      +++ b/tmp/x/b
      @@ -1 +1 @@
      -a
      +b
      """
    let hunks = parseUnifiedDiffHunks(diff)
    #expect(hunks.count == 1)
    #expect(hunks[0].lines.count == 2)
  }
}

@Suite("GitOps.diffHunks")
struct GitOpsDiffHunksTests {
  @Test("同一テキストは空 hunks")
  func identicalIsEmpty() async throws {
    let r = try await GitOps.diffHunks(original: "a\nb\nc\n", current: "a\nb\nc\n")
    #expect(r.hunks.isEmpty)
    #expect(r.oldTotalLines == 3)
    #expect(r.newTotalLines == 3)
  }

  @Test("1 行置換は 1 hunk")
  func singleLineReplace() async throws {
    let r = try await GitOps.diffHunks(original: "a\nb\nc\n", current: "a\nB\nc\n")
    #expect(r.hunks.count == 1)
    let removed = r.hunks[0].lines.filter { $0.kind == .removed }.map(\.text)
    let added = r.hunks[0].lines.filter { $0.kind == .added }.map(\.text)
    #expect(removed == ["b"])
    #expect(added == ["B"])
  }

  @Test("離れた変更は複数 hunks")
  func distantChangesProduceMultipleHunks() async throws {
    // 30 行のうち 1 行目と 30 行目だけ違う → 3 行 context だと 2 hunk
    var origLines: [String] = []
    var currLines: [String] = []
    for i in 1...30 {
      origLines.append("line\(i)")
      currLines.append(i == 1 ? "LINE1" : i == 30 ? "LINE30" : "line\(i)")
    }
    let r = try await GitOps.diffHunks(
      original: origLines.joined(separator: "\n") + "\n",
      current: currLines.joined(separator: "\n") + "\n"
    )
    #expect(r.hunks.count == 2)
    #expect(r.oldTotalLines == 30)
    #expect(r.newTotalLines == 30)
  }

  @Test("末尾に newline が無いケースも parse できる")
  func handlesNoNewlineAtEndOfFile() async throws {
    let r = try await GitOps.diffHunks(original: "a\nb", current: "a\nB")
    #expect(r.hunks.count == 1)
    let added = r.hunks[0].lines.filter { $0.kind == .added }.map(\.text)
    let removed = r.hunks[0].lines.filter { $0.kind == .removed }.map(\.text)
    #expect(removed == ["b"])
    #expect(added == ["B"])
    // 末尾改行なしは git 規約で 1 行多くカウントされる
    #expect(r.oldTotalLines == 2)
    #expect(r.newTotalLines == 2)
  }

  @Test("NUL バイトを含む入力は unexpectedOutput で観察可能に倒す")
  func binaryInputThrows() async throws {
    let withNul = "a\u{0000}b"
    do {
      _ = try await GitOps.diffHunks(original: withNul, current: "different\u{0000}content")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput {
      // expected
    }
  }

  @Test("新規ファイル相当 (original 空 / current あり) は `@@ -0,0 +1,N @@` で hunk を返す")
  func addedFileLikeDiff() async throws {
    let r = try await GitOps.diffHunks(original: "", current: "a\nb\nc\n")
    #expect(r.hunks.count == 1)
    let h = r.hunks[0]
    // unified diff 規約: 旧側が空のとき oldStart=0, oldLines=0
    #expect(h.oldStart == 0)
    #expect(h.oldLines == 0)
    #expect(h.newStart == 1)
    #expect(h.newLines == 3)
    #expect(h.lines.allSatisfy { $0.kind == .added })
    #expect(r.oldTotalLines == 0)
    #expect(r.newTotalLines == 3)
  }

  @Test("削除ファイル相当 (original あり / current 空) は `@@ -1,N +0,0 @@` で hunk を返す")
  func deletedFileLikeDiff() async throws {
    let r = try await GitOps.diffHunks(original: "a\nb\nc\n", current: "")
    #expect(r.hunks.count == 1)
    let h = r.hunks[0]
    #expect(h.oldStart == 1)
    #expect(h.oldLines == 3)
    // 新側が空のとき newStart=0, newLines=0
    #expect(h.newStart == 0)
    #expect(h.newLines == 0)
    #expect(h.lines.allSatisfy { $0.kind == .removed })
    #expect(r.oldTotalLines == 3)
    #expect(r.newTotalLines == 0)
  }
}

@Suite("GitOps.countDiffLines")
struct CountDiffLinesTests {
  @Test("空文字は 0 行")
  func empty() {
    #expect(GitOps.countDiffLines("") == 0)
  }

  @Test("単行 + 改行は 1 行")
  func singleLineWithNewline() {
    #expect(GitOps.countDiffLines("a\n") == 1)
  }

  @Test("単行 + 改行なしは 1 行")
  func singleLineNoNewline() {
    #expect(GitOps.countDiffLines("a") == 1)
  }

  @Test("複数行 + 末尾改行は \\n 数と同じ")
  func multiLineWithTrailingNewline() {
    #expect(GitOps.countDiffLines("a\nb\nc\n") == 3)
  }

  @Test("複数行 + 末尾改行なしは \\n 数 + 1")
  func multiLineNoTrailingNewline() {
    #expect(GitOps.countDiffLines("a\nb\nc") == 3)
  }
}

@Suite("GitOps.splitDiffLines")
struct SplitDiffLinesTests {
  @Test("空文字は空配列")
  func empty() {
    #expect(GitOps.splitDiffLines("") == [])
  }

  @Test("単行 + 末尾改行は 1 要素")
  func singleLineWithNewline() {
    #expect(GitOps.splitDiffLines("a\n") == ["a"])
  }

  @Test("単行 + 末尾改行なしも 1 要素")
  func singleLineNoNewline() {
    #expect(GitOps.splitDiffLines("a") == ["a"])
  }

  @Test("複数行 + 末尾改行は \\n 区切りの terminated 行")
  func multiLineWithTrailingNewline() {
    #expect(GitOps.splitDiffLines("a\nb\nc\n") == ["a", "b", "c"])
  }

  @Test("複数行 + 末尾改行なしは最終行も保持")
  func multiLineNoTrailingNewline() {
    #expect(GitOps.splitDiffLines("a\nb\nc") == ["a", "b", "c"])
  }

  @Test("空行を含む内容も省略しない")
  func keepsEmptyLines() {
    #expect(GitOps.splitDiffLines("a\n\nb\n") == ["a", "", "b"])
  }

  @Test("countDiffLines と要素数が一致する")
  func countAlignsWithCount() {
    let samples = ["", "a", "a\n", "a\nb\nc", "a\nb\nc\n", "a\n\nb\n"]
    for s in samples {
      #expect(UInt32(GitOps.splitDiffLines(s).count) == GitOps.countDiffLines(s))
    }
  }
}

@Suite("GitOps.expandDiffLines")
struct ExpandDiffLinesTests {
  @Test("lines == 0 は空配列を返す")
  func zeroLines() throws {
    let result = try GitOps.expandDiffLines(
      original: "a\nb\nc\n",
      current: "a\nb\nc\n",
      oldStart: 1,
      newStart: 1,
      lines: 0
    )
    #expect(result.isEmpty)
  }

  @Test("1-based でテキスト範囲を切り出す")
  func slicesRange() throws {
    let result = try GitOps.expandDiffLines(
      original: "o1\no2\no3\no4\n",
      current: "c1\nc2\nc3\nc4\n",
      oldStart: 2,
      newStart: 2,
      lines: 2
    )
    #expect(result.count == 2)
    #expect(result[0].oldLineNo == 2)
    #expect(result[0].newLineNo == 2)
    #expect(result[0].oldText == "o2")
    #expect(result[0].newText == "c2")
    #expect(result[1].oldLineNo == 3)
    #expect(result[1].newLineNo == 3)
    #expect(result[1].oldText == "o3")
    #expect(result[1].newText == "c3")
  }

  @Test("末尾改行なしの最終行も切り出せる")
  func trailingNoNewline() throws {
    let result = try GitOps.expandDiffLines(
      original: "a\nb\nc",
      current: "a\nb\nc",
      oldStart: 3,
      newStart: 3,
      lines: 1
    )
    #expect(result.count == 1)
    #expect(result[0].oldText == "c")
    #expect(result[0].newText == "c")
  }

  @Test("範囲外 (old) は GitError.unexpectedOutput を投げる")
  func outOfRangeOld() {
    #expect(throws: GitError.self) {
      try GitOps.expandDiffLines(
        original: "a\nb\n",
        current: "a\nb\nc\n",
        oldStart: 3,
        newStart: 1,
        lines: 1
      )
    }
  }

  @Test("範囲外 (new) は GitError.unexpectedOutput を投げる")
  func outOfRangeNew() {
    #expect(throws: GitError.self) {
      try GitOps.expandDiffLines(
        original: "a\nb\nc\n",
        current: "a\nb\n",
        oldStart: 1,
        newStart: 3,
        lines: 1
      )
    }
  }

  @Test("oldStart == 0 は範囲外として throw する")
  func zeroOldStart() {
    #expect(throws: GitError.self) {
      try GitOps.expandDiffLines(
        original: "a\nb\n",
        current: "a\nb\n",
        oldStart: 0,
        newStart: 1,
        lines: 1
      )
    }
  }

  @Test("newStart == 0 は範囲外として throw する")
  func zeroNewStart() {
    #expect(throws: GitError.self) {
      try GitOps.expandDiffLines(
        original: "a\nb\n",
        current: "a\nb\n",
        oldStart: 1,
        newStart: 0,
        lines: 1
      )
    }
  }

  @Test("空文字 input は lines > 0 で throw")
  func emptyInput() {
    #expect(throws: GitError.self) {
      try GitOps.expandDiffLines(
        original: "",
        current: "",
        oldStart: 1,
        newStart: 1,
        lines: 1
      )
    }
  }
}

@Suite("GitOps.validateRev")
struct GitOpsValidateRevTests {
  @Test("空文字は通過 (working tree blame 経路)")
  func emptyAllowed() throws {
    try validateRev("")
  }

  @Test("HEAD は通過")
  func headAllowed() throws {
    try validateRev("HEAD")
  }

  @Test("hex hash は通過")
  func hexHashAllowed() throws {
    try validateRev("abc1234")
    try validateRev("abcdef0123456789abcdef0123456789abcdef01")
    try validateRev("ABCDEF01")
  }

  @Test("hex hash + 末尾 ^ / ~ は通過")
  func hashWithSuffixAllowed() throws {
    try validateRev("abc1234^")
    try validateRev("abc1234~1")
    try validateRev("abc1234^^")
  }

  @Test("`-` 始まりは option 注入として reject")
  func dashLeading() {
    #expect(throws: GitError.self) { try validateRev("-foo") }
    #expect(throws: GitError.self) { try validateRev("--upload-pack=evil") }
  }

  @Test("非 hex 開始は reject (HEAD は別経路で許可済み)")
  func nonHexStart() {
    #expect(throws: GitError.self) { try validateRev("main") }
    #expect(throws: GitError.self) { try validateRev("origin/main") }
    #expect(throws: GitError.self) { try validateRev("v1.0.0") }
    #expect(throws: GitError.self) { try validateRev("^HEAD") }
  }

  @Test("空白を含む rev は reject")
  func whitespaceRejected() {
    #expect(throws: GitError.self) { try validateRev("abc 1234") }
    #expect(throws: GitError.self) { try validateRev("abc1234 ") }
    #expect(throws: GitError.self) { try validateRev(" abc1234") }
  }

  @Test("hex 外の記号は reject")
  func nonHexSymbol() {
    #expect(throws: GitError.self) { try validateRev("abc;rm -rf /") }
    #expect(throws: GitError.self) { try validateRev("abc/def") }
    #expect(throws: GitError.self) { try validateRev("abc.def") }
  }
}

@Suite("GitOps.logLine")
struct GitOpsLogLineTests {
  @Test("空 rev は unexpectedOutput で reject (blame-anchored contract)")
  func emptyRevRejected() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "v1\nv2\n".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    do {
      _ = try await GitOps.logLine(
        dir: dir.path, relPath: "a.txt", rev: "", line: 1, maxCount: 10)
      Issue.record("expected throw, got success")
    } catch let GitError.unexpectedOutput(message) {
      #expect(message.contains("rev must be specified"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("path に `:` を含む場合は unexpectedOutput で reject")
  func pathColonRejected() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      _ = try await GitOps.logLine(
        dir: dir.path, relPath: "foo:bar.txt", rev: "HEAD", line: 1, maxCount: 10)
      Issue.record("expected throw, got success")
    } catch let GitError.unexpectedOutput(message) {
      #expect(message.contains("path contains ':'"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("`-` 始まりの rev は validateRev で reject")
  func dashRevRejected() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      _ = try await GitOps.logLine(
        dir: dir.path, relPath: "a.txt", rev: "-foo", line: 1, maxCount: 10)
      Issue.record("expected throw, got success")
    } catch let GitError.unexpectedOutput(message) {
      #expect(message.contains("leading '-'"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("正常: HEAD 起点で 1 行の history を返す")
  func historyHappyPath() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("a.txt")
    try "first\n".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "add a"], cwd: dir.path)
    try "first modified\n".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["commit", "-am", "modify a"], cwd: dir.path)

    let commits = try await GitOps.logLine(
      dir: dir.path, relPath: "a.txt", rev: "HEAD", line: 1, maxCount: 10)
    #expect(commits.count == 2)
    #expect(commits[0].message == "modify a")
    #expect(commits[1].message == "add a")
  }
}

@Suite("GitOps.blameLine")
struct GitOpsBlameLineTests {
  @Test("正常: 単一行 blame で author / summary / sourceLine を返す")
  func blameHappyPath() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("a.txt")
    try "first\nsecond\nthird\n".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let info = try await GitOps.blameLine(
      dir: dir.path, relPath: "a.txt", rev: "HEAD", line: 2)
    #expect(info.author == "Test")
    #expect(info.summary == "init")
    #expect(info.sourceLine == 2)
    #expect(info.notCommitted == false)
    #expect(info.hash.count == 40)
    #expect(info.shortHash == String(info.hash.prefix(7)))
  }

  @Test("working tree (rev='') の未コミット行は notCommitted=true")
  func notCommittedLine() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("a.txt")
    try "committed line\n".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)
    // working tree に未コミットの追加行を入れる
    try "committed line\nuncommitted line\n".write(to: file, atomically: true, encoding: .utf8)

    let info = try await GitOps.blameLine(dir: dir.path, relPath: "a.txt", rev: "", line: 2)
    #expect(info.notCommitted == true)
    #expect(info.hash.allSatisfy { $0 == "0" })
  }

  @Test("BLAME_MAX_BLOB_BYTES 超のファイルは unexpectedOutput で reject")
  func sizeGuardRejects() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("big.txt")
    // BLAME_MAX_BLOB_BYTES (2 MiB) + 1 byte の content を 1 行ずつ書く
    let lineCount = (BLAME_MAX_BLOB_BYTES / 4) + 1
    var sb = ""
    sb.reserveCapacity(BLAME_MAX_BLOB_BYTES + 16)
    for _ in 0..<lineCount {
      sb.append("abc\n")
    }
    try sb.write(to: file, atomically: true, encoding: .utf8)

    // working tree (rev="") 経路でサイズ gate を踏む
    do {
      _ = try await GitOps.blameLine(dir: dir.path, relPath: "big.txt", rev: "", line: 1)
      Issue.record("expected throw, got success")
    } catch let GitError.unexpectedOutput(message) {
      #expect(message.contains("file too large"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("`-` 始まり rev は validateRev で reject")
  func dashRevRejected() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

    do {
      _ = try await GitOps.blameLine(dir: dir.path, relPath: "a.txt", rev: "-foo", line: 1)
      Issue.record("expected throw, got success")
    } catch let GitError.unexpectedOutput(message) {
      #expect(message.contains("leading '-'"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> URL {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-gitops-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
}

private func makeGitRepo() async throws -> URL {
  let dir = try makeTempDir()
  // テスト独立性のため、ここでだけ user.name / user.email を local config に入れる。
  try await runTestGit(args: ["init", "-q", "-b", "main"], cwd: dir.path)
  try await runTestGit(args: ["config", "user.name", "Test"], cwd: dir.path)
  try await runTestGit(args: ["config", "user.email", "test@example.com"], cwd: dir.path)
  return dir
}

/// テスト helper: GitOps と同じ `/usr/bin/env git` 経由で任意の git コマンドを実行する。
/// production 側と同じく `process.environment` を明示 snapshot で渡すことで、
/// 並列 test 実行時の Foundation `Process` 内部の lazy env read による EFAULT を避ける。
///
/// stdout は `/dev/null` に直接捨てる（git 出力は本テストでは未使用かつ大量出力対応）。
/// stderr は `Pipe` で捕捉し、失敗時に `GitError.commandFailed(stderr:)` に載せる。
/// 「テストヘルパーも本体と同じ厳密さ」原則に従い、失敗時の調査コストを本体並みに
/// 保つために stderr を握り潰さない。pipe deadlock を避けるため `waitUntilExit()` 後に
/// `readDataToEndOfFile()` を呼ぶ（git の stderr は数百バイト程度なので buffer 溢れの
/// 心配は実用上ない）。
private func runTestGit(args: [String], cwd: String) async throws {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    process.environment = ProcessInfo.processInfo.environment
    process.standardOutput = FileHandle.nullDevice
    let stderrPipe = Pipe()
    process.standardError = stderrPipe
    process.terminationHandler = { proc in
      if proc.terminationStatus == 0 {
        cont.resume()
      } else {
        // `String(decoding:as:)` は不正 UTF-8 を U+FFFD で lossy 置換してしまうので
        // CI flake の真の原因バイトが潰れる。`String(bytes:encoding:)` で UTF-8 失敗を
        // 明示的に nil 判定し、診断用に元データの byte 数を残す。
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stderr =
          String(bytes: stderrData, encoding: .utf8)
          ?? "<non-UTF8 stderr (\(stderrData.count) bytes)>"
        cont.resume(
          throwing: GitError.commandFailed(exitCode: proc.terminationStatus, stderr: stderr))
      }
    }
    do {
      try process.run()
    } catch {
      cont.resume(throwing: error)
    }
  }
}
