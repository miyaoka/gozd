#!/usr/bin/env bash
#
# CI log の `[TEST-TRACE]` waitUntil tick 行を test 横断で時系列ソートし、
# 「同時刻 stall window」を集計する。「どの test の tick がどの時刻に発火したか」
# 「stall window の幅 ( tick 間 gap が閾値を超える区間 ) はどれか」を 1 view で出す。
#
# 対応 helper: `waitUntil` ( dedicated NSThread polling、`mode=threaded` token 付き )。
# perl regex は `waitUntilThreaded` / `waitUntilDispatch` / `waitUntil` ( mode token なし ) も
# OR で拾い、kind 列を `waitUntil-threaded` / `waitUntilThreaded` / `waitUntilDispatch` /
# `waitUntil` の 4 値に正規化する。
#
# 入力: CI log を stdin に流すか、第 1 引数に log file path を渡す。
# 出力:
#   - timeline section: 全 tick を `+elapsed wall=<sec> [test] <kind> tick=N result=B` で
#     時系列出力。wall 列は ContinuousClock と乖離があった場合のみ意味を持つ保険記録
#   - stall windows section: 連続 tick 間の global gap が `STALL_THRESHOLD` ( default 0.5s )
#     を超える window を `gap=Δs from=+a to=+b prev=[...] cur=[...]` で列挙
#
# 使い方:
#   ./apps/native/scripts/analyze-stall.sh ci-log.txt
#   gh api repos/OWNER/REPO/actions/jobs/JOB_ID/logs | ./apps/native/scripts/analyze-stall.sh
#   STALL_THRESHOLD=0.2 ./apps/native/scripts/analyze-stall.sh ci-log.txt
#
# 移植性: macOS default の BWK awk と Linux の gawk 両方で動くよう、GNU awk 固有の
# `match($0, /re/, arr)` array 引数や RSTART/RLENGTH に依存しない。perl の正規表現で
# 抽出してから sort する。

set -euo pipefail

STALL_THRESHOLD="${STALL_THRESHOLD:-0.5}"

input="${1:-/dev/stdin}"

# tick 行を `elapsed<TAB>wall<TAB>test<TAB>kind<TAB>tick<TAB>result` に正規化する。
# trace 行例 ( `mode=...` token は現行版 `waitUntil` で付く。旧 trace との互換のためオプショナル ):
#   2026-05-24T09:00:00.0000000Z [TEST-TRACE +0.004 seconds test=writeRoundTrip()] waitUntil mode=threaded tick=1 elapsed=2.3875e-05 seconds wall=800792337.6 result=false
#   2026-05-18T09:40:24.2295220Z [TEST-TRACE +0.004299333 seconds test=receivesMultipleLines()] waitUntil tick=1 elapsed=2.3875e-05 seconds wall=800792337.6 result=false
# mode token がある行は kind 列に `<prefix>-<mode>` ( 例 `waitUntil-threaded` ) として畳み込む。
extract() {
  perl -ne '
    next unless /\[TEST-TRACE \+([0-9.eE+\-]+) seconds test=(\S+?)\] (waitUntilThreaded|waitUntilDispatch|waitUntil)(?: mode=(\S+))? tick=(\d+) elapsed=\S+ seconds (?:wall=(\S+) )?result=(true|false)/;
    my $elapsed = $1;
    my $name    = $2;
    my $kind    = defined($4) ? "$3-$4" : $3;
    my $tick    = $5;
    my $wall    = defined($6) ? $6 : "";
    my $result  = $7;
    print join("\t", $elapsed, $wall, $name, $kind, $tick, $result), "\n";
  ' "$1" | sort -n -k1,1
}

print_timeline() {
  printf 'timeline:\n'
  while IFS=$'\t' read -r elapsed wall name kind tick result; do
    if [[ -n "$wall" ]]; then
      printf '  +%s wall=%s [%s] %s tick=%s result=%s\n' "$elapsed" "$wall" "$name" "$kind" "$tick" "$result"
    else
      printf '  +%s [%s] %s tick=%s result=%s\n' "$elapsed" "$name" "$kind" "$tick" "$result"
    fi
  done
}

print_stall_windows() {
  local prev=-1 prev_label=""
  local elapsed wall name kind tick result
  while IFS=$'\t' read -r elapsed wall name kind tick result; do
    if [[ "$prev" != "-1" ]]; then
      local gap
      gap=$(awk -v a="$elapsed" -v b="$prev" 'BEGIN { printf "%.4f", a - b }')
      local over
      over=$(awk -v g="$gap" -v t="$STALL_THRESHOLD" 'BEGIN { print (g > t) ? "1" : "0" }')
      if [[ "$over" == "1" ]]; then
        printf '  gap=%ss from=+%s to=+%s prev=[%s] cur=[%s %s tick=%s result=%s]\n' \
          "$gap" "$prev" "$elapsed" "$prev_label" "$name" "$kind" "$tick" "$result"
      fi
    fi
    prev="$elapsed"
    prev_label="$name $kind tick=$tick result=$result"
  done
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
extract "$input" > "$tmp"

print_timeline < "$tmp"
printf '\nstall windows (gap > %ss):\n' "$STALL_THRESHOLD"
print_stall_windows < "$tmp"
