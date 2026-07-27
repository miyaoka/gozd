// TerminalSessionPreview の bubble 選択ロジック。session ログの会話イベント列から
// 「応答 (run) 単位」で preview に出すメッセージを選ぶ純粋関数。SFC から分離して
// 回帰テスト (collectMessages.test.ts 相当) を書けるようにしている。

import type { TranscriptEvent } from "../session-log";

// parseSessionLog の events から user / assistant のみ残した会話イベント。
export interface PreviewEvent {
  kind: "user" | "assistant";
  text: string;
  ts: string;
}

/**
 * 直近の発言以降に積まれた「発言以外のアクション」(thinking / tool) の件数を数える。
 * 0 なら進行中でない (末尾が発言、または発言も作業もない)。1 以上ならその件数が
 * そのまま進行中インジケータの点の数になる。
 *
 * transcript の末尾イベントが thinking / tool なら、直近の発言以降まだ次の発言が
 * 無い = 作業継続中とみなす。末尾が user / assistant (発言) なら 0 に戻し、進行中表示を
 * リセットする。ask は expandAskMessages で user / assistant に展開済みの前提
 * (呼び出し側で展開してから渡す)。
 *
 * system (注入) はエージェント自身のアクションでも発言でもないため透過する (件数にも
 * 数えない)。透過しないと、tool 実行中に hook 注入が末尾に来た瞬間 (tool_use →
 * hook attachment → tool_result の JSONL 順で、tool_result 到着前の window) に進行中表示が
 * 誤って消える。
 *
 * thinking / tool 以外の非発言イベント (image / branch) は透過せず打ち切る。末尾がそれらの
 * ときに進行中としないのは boolean 判定だった頃からの挙動で、`> 0` が旧 `isSessionInProgress`
 * と等価になるよう保っている。
 */
export function countInProgressActions(events: TranscriptEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined || ev.kind === "system") continue;
    if (ev.kind !== "thinking" && ev.kind !== "tool") return count;
    count++;
  }
  return count;
}

// 1 overlay 分の bubble。run 単位で表示対象を選び、events の出現順で並べる。
// LINE 同様の時系列読みになる (上から下が時間の経過方向)。
export interface PreviewMessage {
  kind: "user" | "assistant";
  text: string;
  ts: string;
}

// 連続する同 kind の発話を 1 つの run (応答の塊) として束ねた表示単位。
interface PreviewRun {
  kind: "user" | "assistant";
  messages: PreviewEvent[];
}

// 各 kind とも最新 3 run (= 3 応答分) を表示対象にする
const RUNS_PER_KIND = 3;
// assistant が応答中 (= ログ末尾の run が assistant) のときだけ、その run を末尾 3 件まで
// 展開する (進行中の連続応答の流れを見せる)。user が最新なら応答は完結しているので
// 全 run を最後の 1 件で代表させる
const LATEST_ASSISTANT_RUN_MESSAGES = 3;

export function collectMessages(events: PreviewEvent[]): PreviewMessage[] {
  // 空文字は run 構成前に除外する (tool_result / 注入された空 user 等の取りこぼし対策)。
  // 空文字を挟んだ同 kind 連続が分断されて run 数の数え方がぶれないよう、filter を先に置く
  const spoken = events.filter((e) => e.text !== "");
  const runs: PreviewRun[] = [];
  for (const e of spoken) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === e.kind) {
      last.messages.push(e);
      continue;
    }
    runs.push({ kind: e.kind, messages: [e] });
  }

  // 各 kind の最新 RUNS_PER_KIND run だけ残す
  const kept = new Set<PreviewRun>();
  for (const kind of ["user", "assistant"] as const) {
    const ofKind = runs.filter((r) => r.kind === kind);
    for (const run of ofKind.slice(-RUNS_PER_KIND)) kept.add(run);
  }

  // runs は events 出現順なので、選んだ message をそのまま flatten すれば表示順になる。
  // ts="" / parse 不能 ts の event が混ざっても順序が崩れない (ts での sort はしない)
  const latestRun = runs[runs.length - 1];
  const expandedRun = latestRun?.kind === "assistant" ? latestRun : undefined;
  const out: PreviewMessage[] = [];
  for (const run of runs) {
    if (!kept.has(run)) continue;
    const take = run === expandedRun ? LATEST_ASSISTANT_RUN_MESSAGES : 1;
    for (const m of run.messages.slice(-take)) {
      out.push({ kind: m.kind, text: m.text, ts: m.ts });
    }
  }
  return out;
}
