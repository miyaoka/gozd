#!/usr/bin/env bash
# `FileHandle.standardError.write` の直接呼び出しを許可リスト外で reject する。
# 許可リスト:
#   - apps/native/Sources/GozdCore/**/StderrLog.swift  (helper 本体)
#   - apps/native/Sources/GozdCore/**/PTYTrace.swift   (trace 系統、独自 lock 経路)
#   - apps/native/Sources/GozdCLI/                     (user-facing CLI error 出力)
#
# サブディレクトリ階層を持つレイアウト (`GozdCore/Pty/PTYTrace.swift` 等) でも許可規則が
# 壊れないよう、許可ファイル名の前段に任意のサブディレクトリを許す `(.*/)?` を入れる。
#
# 観察ログ書式の SSOT は `GozdCore.StderrLog.write(tag:_:)`。CLAUDE.md「観察ログ
# (stderr) の書式」を参照。
#
# 使い方:
#   - lefthook pre-commit: staged Swift ファイル群を引数で受け取る
#   - CI / 手動: 引数なしで全件検査

set -euo pipefail

# script location から repo root を解決し cwd に依存させない。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SOURCES_ROOT="$REPO_ROOT/apps/native/Sources"

ALLOWED_PATTERN='apps/native/Sources/(GozdCore/(.*/)?(StderrLog|PTYTrace)\.swift|GozdCLI/)'
PATTERN='FileHandle\.standardError\.write'

found_violation=0

check_file() {
  local file="$1"
  # 許可リストはスキップ
  if [[ "$file" =~ $ALLOWED_PATTERN ]]; then
    return
  fi
  # Swift ソースのみ対象
  case "$file" in
    *.swift) ;;
    *) return ;;
  esac
  if [ ! -f "$file" ]; then
    return
  fi
  # コメント行 (`// ` 始まり) を除外して検査する
  if grep -nE "^[[:space:]]*[^/]*${PATTERN}" "$file" > /dev/null 2>&1; then
    if [ "$found_violation" -eq 0 ]; then
      printf '\033[31m✘ stderr 観察ログ regulation 違反:\033[0m\n'
      printf '  `FileHandle.standardError.write` の直接呼び出しは禁止。\n'
      printf '  `GozdCore.StderrLog.write(tag:_:)` 経由に書き換えてください。\n'
      printf '  詳細は CLAUDE.md「観察ログ (stderr) の書式」を参照。\n\n'
      found_violation=1
    fi
    grep -nE "^[[:space:]]*[^/]*${PATTERN}" "$file" | while IFS= read -r line; do
      printf '  %s:%s\n' "$file" "$line"
    done
    # while サブシェル内では found_violation の伝播が壊れるため file 検知で立てておく
  fi
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    check_file "$file"
  done
else
  if [ ! -d "$SOURCES_ROOT" ]; then
    printf '\033[31m✘ Sources root not found: %s\033[0m\n' "$SOURCES_ROOT" >&2
    exit 2
  fi
  while IFS= read -r file; do
    check_file "$file"
  done < <(find "$SOURCES_ROOT" -name '*.swift')
fi

exit "$found_violation"
