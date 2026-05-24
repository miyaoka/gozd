#!/usr/bin/env bash
# 観察ログ regulation (CLAUDE.md「観察ログ (stderr) の書式」) を構造的に強制する check。
#
# `FileHandle.standardError.write` の直接呼び出しは以下の許可リスト外で禁止:
#   - apps/native/Sources/GozdCore/StderrLog.swift  (helper 本体)
#   - apps/native/Sources/GozdCore/PTYTrace.swift   (trace 系統、独自 lock 経路)
#   - apps/native/Sources/GozdCLI/                  (user-facing CLI error 出力、CLAUDE.md 対象外宣言)
#
# 規約を「helper 経由を SSOT」と宣言した代わりに、grep ベースで違反を CI で reject
# する側の柱を立てる。issue ( #614 ) の「違反を構造的に検出できない」を構造で防ぐ。
#
# 使い方:
#   - lefthook pre-commit: staged Swift ファイル群を引数で受け取る
#   - CI / 手動: 引数なしで全件検査

set -euo pipefail

ALLOWED_PATTERN='apps/native/Sources/(GozdCore/(StderrLog|PTYTrace)\.swift|GozdCLI/)'
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
  while IFS= read -r file; do
    check_file "$file"
  done < <(find apps/native/Sources -name '*.swift')
fi

exit "$found_violation"
