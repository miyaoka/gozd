// TerminalSessionPreview の bubble 選択ロジック。session ログの会話イベント列から
// 「応答 (run) 単位」で preview に出すメッセージを選ぶ純粋関数。SFC から分離して
// 回帰テスト (collectMessages.test.ts 相当) を書けるようにしている。

import { speechesOf, type Speech, type SpeechSpeaker, type TranscriptEvent } from "../session-log";

/**
 * 直近の発言以降に積まれた tool 呼び出しの件数を数える。0 なら進行中でない (末尾が発言、
 * または発言も作業もない)。1 以上ならその件数がそのまま進行中インジケータの点の数になる。
 *
 * 末尾から走査し、吹き出しになる発言を持つ event (`speechesOf`) で打ち切る。打ち切りの判定を
 * 吹き出しの生成と同じ関数に置くのは、preview の bubble 列と件数の増減を一致させるため。bubble に
 * 現れない event で打ち切ると、画面に何も現れないまま点の数が巻き戻る。
 *
 * 吹き出しにならない tool 以外の event (system / image / branch 等) は数えずに読み飛ばす。
 * system は tool_use → hook attachment → tool_result の JSONL 順で tool_result 到着前に末尾へ
 * 来るため、打ち切ると tool 実行中に進行中表示が消える。
 */
export function countInProgressActions(events: TranscriptEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (speechesOf(ev).length > 0) return count;
    if (ev.kind === "tool") count++;
  }
  return count;
}

// 連続する同じ話者の発言を 1 つの run (応答の塊) として束ねた表示単位。
interface PreviewRun {
  speaker: SpeechSpeaker;
  speeches: Speech[];
}

// 各話者とも最新 3 run (= 3 応答分) を表示対象にする
const RUNS_PER_SPEAKER = 3;
// assistant が応答中 (= ログ末尾の run が assistant) のときだけ、その run を末尾 3 件まで
// 展開する (進行中の連続応答の流れを見せる)。user が最新なら応答は完結しているので
// 全 run を最後の 1 件で代表させる
const LATEST_ASSISTANT_RUN_MESSAGES = 3;

/**
 * 1 overlay 分の吹き出しを run 単位で選び、出現順で並べる。LINE 同様の時系列読みになる
 * (上から下が時間の経過方向)。
 */
export function collectMessages(speeches: Speech[]): Speech[] {
  const runs: PreviewRun[] = [];
  for (const s of speeches) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.speaker === s.speaker) {
      last.speeches.push(s);
      continue;
    }
    runs.push({ speaker: s.speaker, speeches: [s] });
  }

  // 各話者の最新 RUNS_PER_SPEAKER run だけ残す
  const kept = new Set<PreviewRun>();
  for (const speaker of ["user", "assistant"] as const) {
    const ofSpeaker = runs.filter((r) => r.speaker === speaker);
    for (const run of ofSpeaker.slice(-RUNS_PER_SPEAKER)) kept.add(run);
  }

  // runs は出現順なので、選んだ発言をそのまま flatten すれば表示順になる。
  // ts="" / parse 不能 ts の event が混ざっても順序が崩れない (ts での sort はしない)
  const latestRun = runs[runs.length - 1];
  const expandedRun = latestRun?.speaker === "assistant" ? latestRun : undefined;
  const out: Speech[] = [];
  for (const run of runs) {
    if (!kept.has(run)) continue;
    const take = run === expandedRun ? LATEST_ASSISTANT_RUN_MESSAGES : 1;
    out.push(...run.speeches.slice(-take));
  }
  return out;
}
