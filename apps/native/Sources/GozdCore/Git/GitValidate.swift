import Foundation

// git CLI に文字列 (rev / path) を渡す前の入口 validator。新規 op を生やす時の checklist として
// 機能する。git 自身も revision parse で reject するため完全な構文再現は目的にせず、
// option 注入 / sandbox 逸脱 / 制御文字混入の **safety net** として機能することだけを担保する。

/// `rev` 文字列を `git` 引数として安全に渡せるか検証する。
///
/// 役割: **option 注入を弾く safety net**。長さ check や git revision syntax の完全再現は
/// 行わない (git 自身が revision parse で reject するため二重実装は避ける)。
///
/// 許可: 空文字 / "HEAD" / 先頭が 16 進文字 (`[0-9a-fA-F]`) で全体が hex + `^` + `~` で構成される文字列。
/// reject: `-` 始まり (option 解釈の余地) / 非 hex 始まり (`main` 等の named ref) / 空白文字 / hex 外の記号。
///
/// 本 RPC が想定する rev 計算経路 (`""` / `"HEAD"` / `<hash>` / `<hash>^` / `<hash>~N`) に
/// 限定する設計判断: hex hash + 末尾 `^` `~N` の組み合わせのみが renderer から流れる契約のため。
/// `HEAD^` / `HEAD~` のような named ref + suffix は本 RPC ではサポートしない (renderer は
/// 必ず hash 化してから流す契約)。
///
/// `internal` にして `@testable import GozdCore` で boundary テストから直接呼べるようにする。
func validateRev(_ rev: String) throws {
  if rev.isEmpty { return }
  if rev == "HEAD" { return }
  let allowed: Set<Character> = Set("0123456789abcdefABCDEF^~")
  guard let first = rev.first else { return }
  // `-` 始まりは絶対禁止 (option 解釈の余地)。
  if first == "-" {
    throw GitError.unexpectedOutput("git rev validation: leading '-' is not allowed: \(rev)")
  }
  // 先頭は 16 進数のいずれかでなければならない。HEAD 等の名前付き ref は本 RPC では使わない契約。
  let hexChars: Set<Character> = Set("0123456789abcdefABCDEF")
  guard hexChars.contains(first) else {
    throw GitError.unexpectedOutput("git rev validation: must start with hex digit: \(rev)")
  }
  for c in rev {
    if !allowed.contains(c) {
      throw GitError.unexpectedOutput("git rev validation: invalid character in rev: \(rev)")
    }
  }
  // 数字も含むため digit-only な短い列を hash と誤認することがあるが、
  // git 自身が revision parse で reject するので 2 重にチェックしない。
}

/// 全 0 hex (`0000000000...`) かどうか。renderer 側の `UNCOMMITTED_HASH` sentinel と一致する。
/// `validateRev` は hex 文字列を通すため別途明示的に弾く必要がある (lsTree 等の
/// 「コミット指定が必須」な RPC 入口での safety net)。
func isAllZeroHex(_ s: String) -> Bool {
  if s.isEmpty { return false }
  for c in s {
    if c != "0" { return false }
  }
  return true
}

/// path が worktree 相対パスとして git 引数に渡せるか検証する。
///
/// 役割: **option 注入と sandbox 逸脱を弾く safety net**。renderer は worktree 相対 path を
/// 送る契約のため、ここで違反したら呼び出し側のバグ (新規 RPC consumer / refactor 由来) で、
/// 表面化させて即診断できるようにする。
///
/// 許可: 空文字 / worktree 相対の通常 path。
/// reject: `-` 始まり (option 注入) / `/` 始まり (絶対パス) / `..` を含む traversal /
///   空白文字 / NUL byte / 改行を含むもの。
func validateRelPath(_ path: String) throws {
  if path.isEmpty { return }
  if path.hasPrefix("-") {
    throw GitError.unexpectedOutput("git path validation: leading '-' is not allowed: \(path)")
  }
  if path.hasPrefix("/") {
    throw GitError.unexpectedOutput("git path validation: absolute path is not allowed: \(path)")
  }
  for component in path.split(separator: "/", omittingEmptySubsequences: false) {
    if component == ".." {
      throw GitError.unexpectedOutput(
        "git path validation: '..' traversal is not allowed: \(path)")
    }
  }
  for c in path {
    if c == "\0" || c == "\n" || c == "\r" {
      throw GitError.unexpectedOutput(
        "git path validation: control character is not allowed: \(path)")
    }
  }
}
