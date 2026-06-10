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

@Suite("GitOps.parseLogRecords")
struct GitOpsParseLogRecordsTests {
  /// runLogStdin の format に一致する 1 record を組み立てる。
  /// `%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%b%x1f%D%x1e`
  private func record(
    hash: String = "0123456789abcdef0123456789abcdef01234567",
    short: String = "0123456",
    parents: String = "",
    author: String = "Test",
    date: String = "1700000000",
    subject: String = "subj",
    body: String = "body",
    refs: String = ""
  ) -> String {
    let us = "\u{1f}"
    let rs = "\u{1e}"
    return [hash, short, parents, author, date, subject, body, refs].joined(separator: us) + rs
  }

  @Test("空入力は空配列")
  func emptyInput() throws {
    #expect(try GitOps.parseLogRecords("").isEmpty)
  }

  @Test("trailing whitespace のみは空配列")
  func whitespaceOnly() throws {
    #expect(try GitOps.parseLogRecords("\n  \n").isEmpty)
  }

  @Test("正常な 1 record をパースして CommitInfo 1 件を返す")
  func singleValidRecord() throws {
    let text = record(
      hash: "aaaa", short: "aaaa", parents: "bbbb cccc", author: "Alice",
      date: "1700000000", subject: "init", body: "body text", refs: "HEAD -> main")
    let commits = try GitOps.parseLogRecords(text)
    #expect(commits.count == 1)
    #expect(commits[0].hash == "aaaa")
    #expect(commits[0].parents == ["bbbb", "cccc"])
    #expect(commits[0].author == "Alice")
    #expect(commits[0].date == 1_700_000_000)
    #expect(commits[0].message == "init")
    #expect(commits[0].body == "body text")
    #expect(commits[0].refs == ["HEAD", "main"])
  }

  @Test("複数 record は出現順に CommitInfo を返す")
  func multipleRecords() throws {
    let text = record(hash: "aa", short: "aa", date: "100") + record(hash: "bb", short: "bb", date: "200")
    let commits = try GitOps.parseLogRecords(text)
    #expect(commits.map(\.hash) == ["aa", "bb"])
  }

  @Test("field 数 != 8 は unexpectedOutput を throw (silent skip しない)")
  func wrongFieldCountThrows() throws {
    // body field に US (`\u{1f}`) を混入させて parts 数を 9 に増やす
    let us = "\u{1f}"
    let rs = "\u{1e}"
    let bad = ["h", "h", "", "a", "100", "subj", "bo\(us)dy", ""].joined(separator: us) + rs
    do {
      _ = try GitOps.parseLogRecords(bad)
      Issue.record("expected unexpectedOutput, got success")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("8 US-separated fields"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("author date が Int64 として parse できない record は unexpectedOutput を throw (epoch 0 倒ししない)")
  func badAuthorDateThrows() throws {
    let text = record(date: "not-a-number")
    do {
      _ = try GitOps.parseLogRecords(text)
      Issue.record("expected unexpectedOutput, got success")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("author date"))
      #expect(msg.contains("not-a-number"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("parents が空文字なら空配列、複数 OID なら space 分割")
  func parentsParsing() throws {
    let none = record(parents: "")
    let one = record(parents: "p1")
    let two = record(parents: "p1 p2")
    #expect(try GitOps.parseLogRecords(none)[0].parents == [])
    #expect(try GitOps.parseLogRecords(one)[0].parents == ["p1"])
    #expect(try GitOps.parseLogRecords(two)[0].parents == ["p1", "p2"])
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

@Suite("GitOps.runGitWithStdin treatNonZeroExitAsSuccess contract")
struct GitOpsRunGitWithStdinContractTests {
  /// 「無視されたパスなし」を作る共通 setup。
  /// .gitignore を作らない git repo で `check-ignore` を呼ぶと exit 1 + stderr 空になる。
  private func setupNoIgnoreRepo() async throws -> URL {
    let dir = try await makeGitRepo()
    // .gitignore を作らない (置けば match して exit 0 になってしまう)
    return dir
  }

  @Test("treatNonZeroExitAsSuccess=true: exit 1 + stderr 空 を success として空 stdout を返す")
  func optInAcceptsNonZeroWhenStderrEmpty() async throws {
    let dir = try await setupNoIgnoreRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let stdinBytes = Data("foo.txt\u{0}".utf8)
    let result = try await runGitWithStdin(
      args: ["check-ignore", "--stdin", "-z"], cwd: dir.path, stdin: stdinBytes,
      treatNonZeroExitAsSuccess: true)
    // 無視 path なし → exit 1、stderr 空、stdout も空
    #expect(result.isEmpty)
  }

  @Test("treatNonZeroExitAsSuccess=false (default): exit 1 + stderr 空 でも commandFailed を throw")
  func defaultThrowsOnNonZeroEvenWhenStderrEmpty() async throws {
    let dir = try await setupNoIgnoreRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let stdinBytes = Data("foo.txt\u{0}".utf8)
    do {
      _ = try await runGitWithStdin(
        args: ["check-ignore", "--stdin", "-z"], cwd: dir.path, stdin: stdinBytes)
      Issue.record("expected commandFailed for exit 1 with default strict semantics, got success")
    } catch GitError.commandFailed {
      // 期待挙動: exit ≠ 0 は default で常に throw
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("treatNonZeroExitAsSuccess の値に関わらず、stderr 非空のときは throw")
  func nonEmptyStderrAlwaysThrows() async throws {
    // git 管理外 dir で `check-ignore --stdin -z` を呼ぶと、git は exit 128 + stderr に
    // "fatal: not a git repository" を出す。treatNonZeroExitAsSuccess の値に関わらず
    // throw されることを示す (緩和は「stderr 空」が必須条件のため)。
    let dir = try makeTempDirURL()
    defer { try? FileManager.default.removeItem(at: dir) }
    let stdinBytes = Data("foo.txt\u{0}".utf8)
    for flag in [false, true] {
      do {
        _ = try await runGitWithStdin(
          args: ["check-ignore", "--stdin", "-z"], cwd: dir.path, stdin: stdinBytes,
          treatNonZeroExitAsSuccess: flag)
        Issue.record(
          "expected commandFailed for stderr-non-empty case (treatNonZeroExitAsSuccess=\(flag))")
      } catch GitError.commandFailed {
        // 期待挙動
      } catch {
        Issue.record("unexpected error (treatNonZeroExitAsSuccess=\(flag)): \(error)")
      }
    }
  }

  private func makeTempDirURL() throws -> URL {
    let raw = FileManager.default.temporaryDirectory
      .appendingPathComponent("gozd-runStdin-contract-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
    return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
  }

  @Test("treatNonZeroExitAsSuccess=true でも exit code が 1 以外なら throw (check-ignore の契約は exit 1 限定)")
  func optInLimitedToExitCode1() async throws {
    // git 管理外 dir で check-ignore --stdin -z を呼ぶと exit 128 + stderr に
    // "fatal: not a git repository" を出すが、敢えて opt-in=true で呼んでも
    // exit code が 1 でない (= 128) ためフラグの緩和分岐に乗らず throw されることを示す。
    // ( stderr 非空 ケースは別 test でカバー済み。ここでは exit code 単独の境界を踏む。 )
    let dir = try makeTempDirURL()
    defer { try? FileManager.default.removeItem(at: dir) }
    let stdinBytes = Data("foo.txt\u{0}".utf8)
    do {
      _ = try await runGitWithStdin(
        args: ["check-ignore", "--stdin", "-z"], cwd: dir.path, stdin: stdinBytes,
        treatNonZeroExitAsSuccess: true)
      Issue.record("expected commandFailed for exit code != 1 even with opt-in")
    } catch let GitError.commandFailed(exitCode, _) {
      // 期待挙動: exit code 128 で throw、opt-in 緩和は exit code 1 限定
      #expect(exitCode != 1)
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("GitOps.log 経路 (treatNonZeroExitAsSuccess=false) で git log が壊れた ref を渡されたら commandFailed throw")
  func logPathThrowsOnBadRef() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    // initial commit を作って HEAD を確立する。
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    // 直接 `runGitWithStdin` で git log を壊れた ref で呼ぶ (runLogStdin は private なので
    // ここで同じ args パスを再現する)。runLogStdin と同じ default-strict 経路で throw することを示す。
    let stdinBytes = Data("refs/heads/does-not-exist\n".utf8)
    do {
      _ = try await runGitWithStdin(
        args: ["log", "--format=%H", "--stdin"], cwd: dir.path, stdin: stdinBytes)
      Issue.record("expected commandFailed for bad revision via runLogStdin-equivalent path")
    } catch GitError.commandFailed {
      // 期待挙動: git log の "fatal: bad revision" が stderr に出るため throw
    } catch {
      Issue.record("unexpected error: \(error)")
    }
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

  @Test("renamed ファイルの旧パスが renameOldPaths に入る")
  func renameOldPathsIsPopulated() async throws {
    // preview の diff が HEAD 側の比較元を旧パスで引くための SSOT。
    // 旧パスを破棄すると renderer は `git show HEAD:<新パス>` で notFound になり
    // 「move + 編集」の diff が全行追加として表示される。
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "content".write(
      to: dir.appendingPathComponent("old.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "old.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)
    try await runTestGit(args: ["mv", "old.txt", "new.txt"], cwd: dir.path)

    let status = try await GitOps.gitStatusFull(dir: dir.path)
    #expect(status.statuses["new.txt"]?.first == "R")
    #expect(status.renameOldPaths["new.txt"] == "old.txt")
  }

  @Test("rename が無ければ renameOldPaths は空")
  func renameOldPathsEmptyWithoutRename() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "v1".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)
    try "v2".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

    let status = try await GitOps.gitStatusFull(dir: dir.path)
    #expect(status.statuses["a.txt"] == ".M")
    #expect(status.renameOldPaths.isEmpty)
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

  @Test("HEAD は完全一致のみ通過、HEAD^ / HEAD~ は reject (named ref + suffix 非対称)")
  func headSuffixRejected() {
    // HEAD は通過 (完全一致 short-circuit)
    #expect(throws: Never.self) { try validateRev("HEAD") }
    // HEAD^ / HEAD~ は先頭文字 H が hex 文字ではないため reject される。docstring の
    // 「named ref + suffix は本 RPC ではサポートしない (renderer は必ず hash 化してから
    // 流す契約)」が test で機械的に保証される
    #expect(throws: GitError.self) { try validateRev("HEAD^") }
    #expect(throws: GitError.self) { try validateRev("HEAD~1") }
    #expect(throws: GitError.self) { try validateRev("HEAD~") }
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

  @Test("ファイルの行数を超えた line は git fatal で commandFailed throw")
  func lineOutOfRange() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("a.txt")
    try "only one line\n".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    do {
      _ = try await GitOps.blameLine(
        dir: dir.path, relPath: "a.txt", rev: "HEAD", line: 9999)
      Issue.record("expected throw, got success")
    } catch let GitError.commandFailed(exitCode, _) {
      // git は範囲外行で exit code != 0 を返す。message 文言は git バージョン依存で
      // 変わりうるので exitCode のみ pin。
      #expect(exitCode != 0)
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("空ファイル (working tree) は size gate 通過後 blame で 0 行 fatal")
  func emptyFileWorkingTree() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("empty.txt")
    try Data().write(to: file)
    try await runTestGit(args: ["add", "empty.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init empty"], cwd: dir.path)

    do {
      _ = try await GitOps.blameLine(dir: dir.path, relPath: "empty.txt", rev: "", line: 1)
      Issue.record("expected throw, got success")
    } catch let GitError.commandFailed(exitCode, _) {
      // 0 行ファイルで `-L 1,1` は範囲外なので git fatal。size gate は通過する
      // (空ファイル = 0 byte で BLAME_MAX_BLOB_BYTES 以下)。
      #expect(exitCode != 0)
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.parseLsTree")
struct GitOpsParseLsTreeTests {
  @Test("空入力は空配列")
  func empty() throws {
    let result = try parseLsTree(Data())
    #expect(result.isEmpty)
  }

  @Test("blob は kind: 'file' になる")
  func blobEntry() throws {
    let raw = "100644 blob abcdef\tREADME.md\0"
    let result = try parseLsTree(Data(raw.utf8))
    #expect(result == [GitTreeEntryInfo(name: "README.md", type: "file")])
  }

  @Test("tree は kind: 'directory' になる")
  func treeEntry() throws {
    let raw = "040000 tree abcdef\tsrc\0"
    let result = try parseLsTree(Data(raw.utf8))
    #expect(result == [GitTreeEntryInfo(name: "src", type: "directory")])
  }

  @Test("mode 120000 は kind: 'symlink' になる")
  func symlinkMode() throws {
    let raw = "120000 blob abcdef\tlink\0"
    let result = try parseLsTree(Data(raw.utf8))
    #expect(result == [GitTreeEntryInfo(name: "link", type: "symlink")])
  }

  @Test("mode 160000 (gitlink) は kind: 'submodule' になる")
  func submoduleMode() throws {
    let raw = "160000 commit abcdef\tvendor\0"
    let result = try parseLsTree(Data(raw.utf8))
    #expect(result == [GitTreeEntryInfo(name: "vendor", type: "submodule")])
  }

  @Test("末尾 / 付き呼び出しで <parent>/<basename> 形式の path から basename だけ抽出する")
  func basenameExtraction() throws {
    let raw = "100644 blob abcdef\tdocs/intro.md\0"
    let result = try parseLsTree(Data(raw.utf8))
    #expect(result == [GitTreeEntryInfo(name: "intro.md", type: "file")])
  }

  @Test("複数 record は name 順にソートして返す")
  func sortedByName() throws {
    let raw = """
      100644 blob aaaa\tz.md\0\
      040000 tree bbbb\tapps\0\
      100644 blob cccc\ta.md\0
      """
    let result = try parseLsTree(Data(raw.utf8))
    #expect(result.map { $0.name } == ["a.md", "apps", "z.md"])
  }

  @Test("TAB 不在の record は unexpectedOutput で throw する (silent skip しない)")
  func missingTab() {
    let raw = "100644 blob abcdef README.md\0"
    do {
      _ = try parseLsTree(Data(raw.utf8))
      Issue.record("expected throw, got success")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("missing TAB"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("非 UTF-8 bytes は unexpectedOutput で throw する (lossy U+FFFD 置換を許さない)")
  func nonUtf8Input() {
    // 0xFF 0xFE は UTF-8 として不正。`String(decoding:as:)` は U+FFFD に置換するが、
    // `String(bytes:encoding:)` は nil を返すので throw に倒す。
    let data = Data([0xFF, 0xFE, 0x00])
    do {
      _ = try parseLsTree(data)
      Issue.record("expected throw, got success")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("non-UTF-8"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("header の SP 区切りフィールドが 3 でない record は throw する")
  func malformedHeader() {
    let raw = "100644 blob\tREADME.md\0"
    do {
      _ = try parseLsTree(Data(raw.utf8))
      Issue.record("expected throw, got success")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("3 SP-delimited"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.typeFromGitMode")
struct GitOpsTypeFromGitModeTests {
  @Test("040000 は directory")
  func directory() {
    #expect(typeFromGitMode("040000") == "directory")
  }

  @Test("120000 は symlink")
  func symlink() {
    #expect(typeFromGitMode("120000") == "symlink")
  }

  @Test("160000 は submodule")
  func submodule() {
    #expect(typeFromGitMode("160000") == "submodule")
  }

  @Test("100644 / 100755 / unknown はすべて file に倒れる")
  func file() {
    #expect(typeFromGitMode("100644") == "file")
    #expect(typeFromGitMode("100755") == "file")
    #expect(typeFromGitMode("") == "file")
    #expect(typeFromGitMode("999999") == "file")
  }
}

@Suite("GitOps.isAllZeroHex")
struct GitOpsIsAllZeroHexTests {
  @Test("全て 0 の文字列は true")
  func allZero() {
    #expect(isAllZeroHex("0000000000000000000000000000000000000000"))
    #expect(isAllZeroHex("0"))
  }

  @Test("非 0 文字を含むと false")
  func notAllZero() {
    #expect(!isAllZeroHex("0000000000000000000000000000000000000001"))
    #expect(!isAllZeroHex("abc"))
  }

  @Test("空文字は false (UNCOMMITTED_HASH ではない)")
  func emptyString() {
    #expect(!isAllZeroHex(""))
  }
}

@Suite("GitOps.validateRelPath")
struct GitOpsValidateRelPathTests {
  @Test("空文字は通過する (root 指定用)")
  func emptyPath() throws {
    try validateRelPath("")
  }

  @Test("通常の相対 path は通過する")
  func normalPath() throws {
    try validateRelPath("src/foo.ts")
    try validateRelPath("docs")
  }

  @Test("末尾 / 付きの path も通過する (lsTree 規約)")
  func trailingSlash() throws {
    try validateRelPath("src/")
  }

  @Test("内部二重 `/` は素通り (git の path normalization に委ねる契約)")
  func internalDoubleSlash() throws {
    // validateRelPath の主目的は option 注入 / 絶対パス / `..` traversal 防御で、
    // path normalization は git に委ねる契約。`"foo//"` / `"a//b"` のような空 component を
    // 含む path は素通り (throw しない) ことを test で固定し、将来の reject 変更を regression
    // で検出できるようにする。
    try validateRelPath("foo//")
    try validateRelPath("a//b")
  }

  @Test("`-` 始まりは option 注入として reject")
  func leadingDash() {
    do {
      try validateRelPath("-rf")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("leading '-'"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("`/` 始まりは絶対パスとして reject")
  func absolutePath() {
    do {
      try validateRelPath("/etc/passwd")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("absolute"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("path component に `..` を含むものは traversal として reject")
  func parentTraversal() {
    do {
      try validateRelPath("../../etc/passwd")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("traversal"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
    do {
      try validateRelPath("foo/../bar")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("制御文字 (\\0 / \\n / \\r) を含むものは reject")
  func controlCharacters() {
    do {
      try validateRelPath("foo\0bar")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
    }
    do {
      try validateRelPath("foo\nbar")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.lsTree (integration)")
struct GitOpsLsTreeTests {
  @Test("空文字 hash は unexpectedOutput で reject")
  func emptyHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      _ = try await GitOps.lsTree(dir: dir.path, hash: "", path: "")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("must be specified"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("UNCOMMITTED_HASH (all-zero hex) は明示 reject")
  func allZeroHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      _ = try await GitOps.lsTree(
        dir: dir.path, hash: "0000000000000000000000000000000000000000", path: "")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("all-zero"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("`-` 始まり path は reject")
  func dashPath() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      _ = try await GitOps.lsTree(
        dir: dir.path, hash: "0123456789abcdef0123456789abcdef01234567", path: "-rf")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("leading '-'"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("repo root の 1 階層を file / directory 込みで返す")
  func rootListing() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    try "hello".write(
      to: dir.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(
      at: dir.appendingPathComponent("src"), withIntermediateDirectories: false)
    try "x".write(
      to: dir.appendingPathComponent("src/a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "."], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let hash = try await currentHeadHash(dir: dir.path)
    let entries = try await GitOps.lsTree(dir: dir.path, hash: hash, path: "")

    #expect(entries.contains { $0.name == "README.md" && $0.type == "file" })
    #expect(entries.contains { $0.name == "src" && $0.type == "directory" })
  }

  @Test("path 指定で配下の 1 階層を返す (末尾 / は自動付与)")
  func subdirListing() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    try FileManager.default.createDirectory(
      at: dir.appendingPathComponent("docs"), withIntermediateDirectories: false)
    try "intro".write(
      to: dir.appendingPathComponent("docs/intro.md"), atomically: true, encoding: .utf8)
    try "guide".write(
      to: dir.appendingPathComponent("docs/guide.md"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "."], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let hash = try await currentHeadHash(dir: dir.path)
    let entries = try await GitOps.lsTree(dir: dir.path, hash: hash, path: "docs")
    #expect(entries.map { $0.name } == ["guide.md", "intro.md"])
    #expect(entries.allSatisfy { $0.type == "file" })
  }

  @Test("symlink (mode 120000) は kind: 'symlink' として返る")
  func symlinkEntry() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    try "target".write(
      to: dir.appendingPathComponent("target.txt"), atomically: true, encoding: .utf8)
    try FileManager.default.createSymbolicLink(
      at: dir.appendingPathComponent("link.txt"),
      withDestinationURL: URL(fileURLWithPath: "target.txt"))
    try await runTestGit(args: ["add", "."], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    let hash = try await currentHeadHash(dir: dir.path)
    let entries = try await GitOps.lsTree(dir: dir.path, hash: hash, path: "")
    #expect(entries.contains { $0.name == "link.txt" && $0.type == "symlink" })
  }

  @Test("存在しない hash は git の commandFailed で throw する (silent fallback しない)")
  func nonExistentHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      _ = try await GitOps.lsTree(
        dir: dir.path, hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", path: "")
      Issue.record("expected throw")
    } catch GitError.commandFailed {
      // ok: git 自身が `fatal: Not a valid object name` で reject する
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.resetMixed (integration)")
struct GitOpsResetMixedTests {
  @Test("空文字 hash は unexpectedOutput で reject")
  func emptyHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      try await GitOps.resetMixed(dir: dir.path, hash: "")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("must be specified"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("UNCOMMITTED_HASH (all-zero hex) は明示 reject")
  func allZeroHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      try await GitOps.resetMixed(
        dir: dir.path, hash: "0000000000000000000000000000000000000000")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("all-zero"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("`-` 始まり hash は validateRev が option 注入として reject")
  func dashHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    do {
      try await GitOps.resetMixed(dir: dir.path, hash: "--hard")
      Issue.record("expected throw")
    } catch GitError.unexpectedOutput(let msg) {
      #expect(msg.contains("leading '-'"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("存在しない hash は git の commandFailed で throw する (silent fallback しない)")
  func nonExistentHash() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // reset 対象がある状態を作る (空 repo だと別経路の fatal になり得るため)
    try "seed".write(
      to: dir.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "."], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "seed"], cwd: dir.path)

    do {
      try await GitOps.resetMixed(
        dir: dir.path, hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
      Issue.record("expected throw")
    } catch GitError.commandFailed {
      // ok: git 自身が `fatal: ... unknown revision` で reject する
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("branch ref を移動し index を reset するが working tree は保持する")
  func movesBranchResetsIndexPreservesWorkingTree() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // c1: a.txt = "v1" のみ
    let aURL = dir.appendingPathComponent("a.txt")
    try "v1".write(to: aURL, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "."], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    let c1 = try await currentHeadHash(dir: dir.path)

    // c2: a.txt を "v2" に書き換え、b.txt = "new" を追加
    try "v2".write(to: aURL, atomically: true, encoding: .utf8)
    try "new".write(
      to: dir.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "."], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c2"], cwd: dir.path)

    try await GitOps.resetMixed(dir: dir.path, hash: c1)

    // branch ref が c1 へ移動した
    #expect(try await currentHeadHash(dir: dir.path) == c1)

    // working tree は c2 の状態のまま保持される (--mixed は working tree を触らない)
    #expect(try String(contentsOf: aURL, encoding: .utf8) == "v2")
    #expect(
      try String(
        contentsOf: dir.appendingPathComponent("b.txt"), encoding: .utf8) == "new")

    // index は c1 へ reset される: a.txt は staged ではなく working tree 変更 ( M)、
    // c1 に存在しない b.txt は untracked (??) に落ちる
    let status = try await porcelainStatus(dir: dir.path)
    #expect(status.contains(" M a.txt"))
    #expect(status.contains("?? b.txt"))
  }
}

@Suite("GitOps.upstreamRefName")
struct GitOpsUpstreamRefNameTests {
  @Test("upstream 未設定 (push 前) は commandFailed を throw")
  func notConfigured() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    // initial commit を作る (HEAD を確立しないと `@{upstream}` は別エラーになる)
    try "seed".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    do {
      _ = try await GitOps.upstreamRefName(dir: dir.path)
      Issue.record("expected commandFailed, got success")
    } catch GitError.commandFailed {
      // 期待挙動
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("upstream 設定済みなら ref 名 (例: origin/main) を返す")
  func configured() async throws {
    let (local, origin) = try await makeLocalUpstreamRepoPair()
    defer {
      try? FileManager.default.removeItem(at: local)
      try? FileManager.default.removeItem(at: origin)
    }
    let result = try await GitOps.upstreamRefName(dir: local.path)
    #expect(result == "origin/main")
  }

  @Test("detached HEAD では commandFailed を throw")
  func detachedHead() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    let head = try await currentHeadHash(dir: dir.path)
    try await runTestGit(args: ["checkout", "--detach", head], cwd: dir.path)

    do {
      _ = try await GitOps.upstreamRefName(dir: dir.path)
      Issue.record("expected commandFailed, got success")
    } catch GitError.commandFailed {
      // 期待挙動
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test("unborn branch (initial commit 前) では commandFailed を throw")
  func unbornBranch() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    // makeGitRepo は init -q -b main しかしないので、commit 前は unborn branch 状態
    do {
      _ = try await GitOps.upstreamRefName(dir: dir.path)
      Issue.record("expected commandFailed, got success")
    } catch GitError.commandFailed {
      // 期待挙動
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.branchHeadName")
struct GitOpsBranchHeadNameTests {
  @Test("通常 branch は branch 名を返す")
  func normalBranch() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    try await runTestGit(args: ["branch", "-m", "feature/foo"], cwd: dir.path)

    let result = try await GitOps.branchHeadName(dir: dir.path)
    #expect(result == "feature/foo")
  }

  @Test("unborn branch (commit 無し) でも branch 名を返す (porcelain v2 と同 SSOT)")
  func unbornBranch() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    // makeGitRepo は init -q -b main 直後で commit が無い unborn 状態
    let result = try await GitOps.branchHeadName(dir: dir.path)
    #expect(result == "main")
  }

  @Test("detached HEAD では commandFailed を throw")
  func detachedHead() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    let head = try await currentHeadHash(dir: dir.path)
    try await runTestGit(args: ["checkout", "--detach", head], cwd: dir.path)

    do {
      _ = try await GitOps.branchHeadName(dir: dir.path)
      Issue.record("expected commandFailed for detached HEAD")
    } catch GitError.commandFailed {
      // 期待挙動
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("GitOps.headOidExists")
struct GitOpsHeadOidExistsTests {
  @Test("通常 branch (commit あり) では true")
  func normalBranch() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)

    let result = await GitOps.headOidExists(dir: dir.path)
    #expect(result == true)
  }

  @Test("unborn branch では false (HEAD が commit を指していない)")
  func unbornBranch() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    // makeGitRepo は init -q -b main 直後で commit が無い unborn 状態
    let result = await GitOps.headOidExists(dir: dir.path)
    #expect(result == false)
  }

  @Test("git repo でない dir では false (graph 表示を止めない fallback)")
  func notARepo() async throws {
    let tmp = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmp) }

    let result = await GitOps.headOidExists(dir: tmp.path)
    #expect(result == false)
  }
}

@Suite("GitOps.log (--stdin で N ref を 1 walk)")
struct GitOpsLogTests {
  @Test("origin / upstream 不在の repo では HEAD のみで commits を返す")
  func headOnly() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    try "b".write(
      to: dir.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "b.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c2"], cwd: dir.path)

    let result = try await GitOps.log(
      dir: dir.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    #expect(result.defaultBranch == "")
    #expect(result.commits.count == 2)
    #expect(result.commits.first?.message == "c2")
  }

  @Test("amend 後の orphan upstream tip が commits に含まれる")
  func amendOrphanTipVisible() async throws {
    let (local, origin) = try await makeLocalUpstreamRepoPair()
    defer {
      try? FileManager.default.removeItem(at: local)
      try? FileManager.default.removeItem(at: origin)
    }
    // local で 1 commit 追加 → push → amend (push しない)
    try "feat".write(
      to: local.appendingPathComponent("feat.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "feat.txt"], cwd: local.path)
    try await runTestGit(args: ["commit", "-m", "feat"], cwd: local.path)
    try await runTestGit(args: ["push", "-u", "origin", "main"], cwd: local.path)
    let preAmendHash = try await currentHeadHash(dir: local.path)
    try await runTestGit(args: ["commit", "--amend", "-m", "feat (amended)"], cwd: local.path)
    let postAmendHash = try await currentHeadHash(dir: local.path)
    #expect(preAmendHash != postAmendHash)

    let result = try await GitOps.log(
      dir: local.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    let hashes = Set(result.commits.map(\.hash))
    // amend 後の新 HEAD commit
    #expect(hashes.contains(postAmendHash))
    // origin/main が指す amend 前の orphan tip (HEAD 系統から到達不可) も含まれる
    #expect(hashes.contains(preAmendHash))
  }

  @Test("currentBranchOnly=true では origin/<default> も upstream も walk しない")
  func currentBranchOnlySkipsSideStreams() async throws {
    let (local, origin) = try await makeLocalUpstreamRepoPair()
    defer {
      try? FileManager.default.removeItem(at: local)
      try? FileManager.default.removeItem(at: origin)
    }
    // 別ブランチに切り替え (HEAD と origin/main が分岐)
    try await runTestGit(args: ["checkout", "-b", "feature"], cwd: local.path)
    try "feat".write(
      to: local.appendingPathComponent("feat.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "feat.txt"], cwd: local.path)
    try await runTestGit(args: ["commit", "-m", "feat"], cwd: local.path)
    // main から bumpcommit を 1 つ追加 (origin/main が HEAD から到達不可な独立 commit を持つ)
    try await runTestGit(args: ["checkout", "main"], cwd: local.path)
    try "bump".write(
      to: local.appendingPathComponent("bump.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "bump.txt"], cwd: local.path)
    try await runTestGit(args: ["commit", "-m", "bump"], cwd: local.path)
    try await runTestGit(args: ["push", "origin", "main"], cwd: local.path)
    try await runTestGit(args: ["checkout", "feature"], cwd: local.path)

    let withSides = try await GitOps.log(
      dir: local.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    let onlyHead = try await GitOps.log(
      dir: local.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: true,
      sortMode: .topo)
    // currentBranchOnly=true は HEAD walk のみなので "bump" commit (origin/main 由来) は出ない
    #expect(withSides.commits.contains(where: { $0.message == "bump" }))
    #expect(!onlyHead.commits.contains(where: { $0.message == "bump" }))
    // defaultBranch 文字列は currentBranchOnly でも引き続き返る (RefBadge isDefault 用)
    #expect(onlyHead.defaultBranch == "main")
  }

  @Test("未 push の rebase 後、orphan 連鎖 (複数 commit) が全件 visible に含まれる")
  func rebaseOrphanChainVisible() async throws {
    let (local, origin) = try await makeLocalUpstreamRepoPair()
    defer {
      try? FileManager.default.removeItem(at: local)
      try? FileManager.default.removeItem(at: origin)
    }
    // 3 commit 積んで push → 1 commit に squash (= 残り 2 commit が orphan 化)
    for i in 1...3 {
      try "v\(i)".write(
        to: local.appendingPathComponent("f\(i).txt"), atomically: true, encoding: .utf8)
      try await runTestGit(args: ["add", "f\(i).txt"], cwd: local.path)
      try await runTestGit(args: ["commit", "-m", "c\(i)"], cwd: local.path)
    }
    try await runTestGit(args: ["push", "-u", "origin", "main"], cwd: local.path)
    // push 後の orphan 化対象 (c1 / c2) の hash を控える
    let orphanC1 = try await commitHashAt(dir: local.path, rev: "HEAD~2")
    let orphanC2 = try await commitHashAt(dir: local.path, rev: "HEAD~1")
    // 3 commit を `reset --soft HEAD~3` + 1 commit に squash する (interactive rebase 等価)。
    // origin/main は push 直後の HEAD (= c3) を指したまま固定される。
    try await runTestGit(args: ["reset", "--soft", "HEAD~3"], cwd: local.path)
    try await runTestGit(args: ["commit", "-m", "squashed"], cwd: local.path)
    let newHead = try await currentHeadHash(dir: local.path)

    let result = try await GitOps.log(
      dir: local.path, maxCount: 100, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    let hashes = Set(result.commits.map(\.hash))
    // 新 HEAD は visible
    #expect(hashes.contains(newHead))
    // origin/main が指す c3 (== HEAD 系統から到達不可な orphan tip) と、その親 c2 / c1 まで
    // 「orphan 連鎖」全件が visible commit set に含まれる
    let orphanTip = try await commitHashAt(dir: local.path, rev: "origin/main")
    #expect(hashes.contains(orphanTip))
    #expect(hashes.contains(orphanC1))
    #expect(hashes.contains(orphanC2))
  }

  @Test("unborn branch では throw せず空 commits + branchHead=main を返す")
  func unbornBranchYieldsEmptyCommitsWithoutThrow() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    // makeGitRepo は init -q -b main 直後で commit が無い unborn 状態。HEAD は commit を
    // 指していないため、HEAD を始点 ref に入れると `git log --stdin` が exit 128 で throw する。
    // log() は headOidExists で事前検証し、unborn の HEAD を refs から除外することで
    // strict 契約を壊さず unborn を正常系として扱う (新規 worktree 開封時の graph 初期化失敗を回避)。
    let result = try await GitOps.log(
      dir: dir.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    #expect(result.commits.isEmpty)
    #expect(result.defaultBranch == "")
    // unborn でも `git symbolic-ref --short HEAD` は branch 名 (main) を返す
    #expect(result.branchHead == "main")
  }

  @Test("LogResult.branchHead は git symbolic-ref --short HEAD と一致する (porcelain v2 SSOT)")
  func branchHeadInResult() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    try await runTestGit(args: ["branch", "-m", "feature/foo"], cwd: dir.path)

    let result = try await GitOps.log(
      dir: dir.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    #expect(result.branchHead == "feature/foo")
  }

  @Test("LogResult.branchHead は detached HEAD で空文字に倒れる")
  func branchHeadEmptyOnDetachedHead() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }
    try "a".write(
      to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "c1"], cwd: dir.path)
    let head = try await currentHeadHash(dir: dir.path)
    try await runTestGit(args: ["checkout", "--detach", head], cwd: dir.path)

    let result = try await GitOps.log(
      dir: dir.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    #expect(result.branchHead == "")
  }

  @Test("git で 1 度に dedup されるため、 fork workflow 風に upstream==origin/<default> でも commit が重複しない")
  func gitDedupesAcrossRefs() async throws {
    let (local, origin) = try await makeLocalUpstreamRepoPair()
    defer {
      try? FileManager.default.removeItem(at: local)
      try? FileManager.default.removeItem(at: origin)
    }
    let result = try await GitOps.log(
      dir: local.path, maxCount: 50, firstParentOnly: false, currentBranchOnly: false,
      sortMode: .topo)
    let hashes = result.commits.map(\.hash)
    let unique = Set(hashes)
    #expect(hashes.count == unique.count)
  }
}

// MARK: - Helpers

private func commitHashAt(dir: String, rev: String) async throws -> String {
  let stdout = try await runGit(args: ["rev-parse", rev], cwd: dir)
  return String(decoding: stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func currentHeadHash(dir: String) async throws -> String {
  let stdout = try await runGit(args: ["rev-parse", "HEAD"], cwd: dir)
  return String(decoding: stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func porcelainStatus(dir: String) async throws -> String {
  let stdout = try await runGit(args: ["status", "--porcelain"], cwd: dir)
  return String(decoding: stdout, as: UTF8.self)
}

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

/// origin remote + upstream tracking が確立した local repo と、その origin として使う
/// bare repo の URL を返す。caller は両方を removeItem で掃除する責任を持つ。
/// initial commit が main ブランチに 1 つあり、`origin/HEAD = main`、`@{upstream} = origin/main` に
/// なっている状態。`/usr/bin/env git` 側の `init.defaultBranch` がユーザー環境で `master` 等に
/// 設定されているケースを `init -b main` で固定する。
private func makeLocalUpstreamRepoPair() async throws -> (local: URL, origin: URL) {
  let origin = try makeTempDir()
  try await runTestGit(args: ["init", "-q", "--bare", "-b", "main"], cwd: origin.path)
  let local = try await makeGitRepo()
  try "seed".write(
    to: local.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
  try await runTestGit(args: ["add", "seed.txt"], cwd: local.path)
  try await runTestGit(args: ["commit", "-m", "seed"], cwd: local.path)
  try await runTestGit(args: ["remote", "add", "origin", origin.path], cwd: local.path)
  try await runTestGit(args: ["push", "-u", "origin", "main"], cwd: local.path)
  // origin/HEAD → main を確定 (bare 直 push だけだと一部の git バージョンで未設定が残るため)。
  try await runTestGit(
    args: ["remote", "set-head", "origin", "main"], cwd: local.path)
  return (local, origin)
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
