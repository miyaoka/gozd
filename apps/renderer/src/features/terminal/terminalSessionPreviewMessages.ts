// TerminalSessionPreview の bubble 選択ロジック。session ログの会話イベント列を「応答 (run)
// 単位」に束ね、各 run の畳み方を決める純粋関数。SFC から分離して回帰テストを書けるようにしている。

import { speechesOf, type Speech, type SpeechSpeaker, type TranscriptEvent } from "../session-log";

/**
 * ターン境界か。ターン境界はエージェントの作業の区切りで、吹き出しになる発言と、ユーザーの中断が
 * これにあたる。中断は吹き出しにならないが、それより前の作業はユーザーが止めたもので、中断の時点で
 * 応答は終わっている。
 *
 * 発言の判定を吹き出しの生成と同じ関数 (`speechesOf`) に置くのは、preview の bubble 列と進行中の
 * 表示の増減を一致させるため。bubble に現れない発言以外の event (system / image / branch 等) を
 * 境界にすると、画面に何も現れないまま点の数が巻き戻る。system は tool_use → hook attachment →
 * tool_result の JSONL 順で tool_result 到着前に末尾へ来るため、境界にすると tool 実行中に進行中
 * 表示が消える。
 */
function isTurnBoundary(ev: TranscriptEvent): boolean {
  return ev.kind === "interrupt" || speechesOf(ev).length > 0;
}

/**
 * 直近のターン境界以降に積まれた tool 呼び出しの件数を数える。0 なら進行中でない (末尾が
 * ターン境界、または境界も作業もない)。1 以上ならその件数がそのまま進行中インジケータの点の数になる。
 */
export function countInProgressActions(events: TranscriptEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (isTurnBoundary(ev)) return count;
    if (ev.kind === "tool") count++;
  }
  return count;
}

/** 直近のターン境界が中断か。中断で終わったログは応答中ではない。 */
export function endsWithInterrupt(events: TranscriptEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (isTurnBoundary(ev)) return ev.kind === "interrupt";
  }
  return false;
}

/** 吹き出しにする発言と、その発言が属する rewind の枝。 */
export interface PreviewSpeech {
  speech: Speech;
  /**
   * 直前の分岐点 (`branch` イベント) で表示している枝の先頭レコードの uuid。分岐点より前の
   * 発言は空文字。rewind すると新しい枝の先頭レコードが新しい uuid を持つので、分岐点より後ろの
   * 発言はすべて別の値になる
   */
  branch: string;
}

/** event 列から吹き出しにする発言を取り出し、それぞれに属する枝を添える。 */
export function previewSpeeches(events: TranscriptEvent[]): PreviewSpeech[] {
  const out: PreviewSpeech[] = [];
  let branch = "";
  for (const ev of events) {
    if (ev.kind === "branch") {
      branch = ev.selectedChildUuid;
      continue;
    }
    for (const speech of speechesOf(ev)) out.push({ speech, branch });
  }
  return out;
}

/** 連続する同じ話者・同じ枝の発言を 1 つに束ねた表示単位 (応答の塊)。 */
export interface PreviewRun {
  /**
   * run 先頭の発言の、発言列全体での位置。同じ枝の上でログが追記される限り、既存 run の値は
   * 変わらない
   */
  start: number;
  /** run の発言が属する枝 (`PreviewSpeech.branch`)。run は枝をまたがない */
  branch: string;
  speaker: SpeechSpeaker;
  speeches: Speech[];
  /** 畳んだ状態で見せる末尾の件数 */
  foldedCount: number;
}

// assistant が応答中 (= ログ末尾の run が assistant で、ログが中断で終わっていない) のときだけ、
// その run を畳んでも末尾 3 件見せる (進行中の連続応答の流れを見せる)。user が最新、または中断で
// 終わっていれば応答は完結しているので、全 run を最後の 1 件で代表させる
const LATEST_ASSISTANT_RUN_FOLDED_COUNT = 3;
const RUN_FOLDED_COUNT = 1;

/**
 * 1 overlay 分の発言を run に束ね、出現順で並べる。LINE 同様の時系列読みになる (上から下が
 * 時間の経過方向)。ts="" / parse 不能 ts の発言が混ざっても順序が崩れないよう、ts での sort は
 * しない。分岐点では同じ話者の発言でも run を分け、run が枝をまたがないようにする。
 * `interrupted` はログが中断で終わったか (`endsWithInterrupt`)。
 */
export function collectRuns(items: PreviewSpeech[], interrupted: boolean): PreviewRun[] {
  const runs: PreviewRun[] = [];
  items.forEach(({ speech, branch }, index) => {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.speaker === speech.speaker && last.branch === branch) {
      last.speeches.push(speech);
      return;
    }
    runs.push({
      start: index,
      branch,
      speaker: speech.speaker,
      speeches: [speech],
      foldedCount: RUN_FOLDED_COUNT,
    });
  });

  const latestRun = runs[runs.length - 1];
  if (latestRun?.speaker === "assistant" && !interrupted) {
    latestRun.foldedCount = LATEST_ASSISTANT_RUN_FOLDED_COUNT;
  }
  return runs;
}

/**
 * run の開閉状態の key。セッションログ 1 本の id (main は session_id、sub は agent_id)、run の枝、
 * run の start の組にする。id が無いと、表示するセッションログが切り替わったとき同じ start の別の
 * run が開閉状態を引き継ぐ。枝が無いと、rewind で分岐点より後ろが新しい枝に置き換わったとき、
 * 同じ start に来た新しい run が引き継ぐ。同じ枝への追記では key は変わらない。
 */
export function runKey(logId: string, run: PreviewRun): string {
  return `${logId}:${run.branch}:${run.start}`;
}

/** 開いたとき、畳んでいた発言を開閉トグルのどちら側に出すか */
export type RevealSide = "above" | "below";

/** run を描く行。開閉トグルか、発言と、その発言列全体での位置 */
export type RunRow =
  | { kind: "toggle"; foldableCount: number }
  | { kind: "speech"; index: number; speech: Speech };

/**
 * run を開閉状態に応じて行に並べる。畳んだ run は古い側 (先頭) を隠して末尾を残し、隠れる発言が
 * あれば末尾の直前に開閉トグルを置く。開くと隠れていた発言をトグルの `revealSide` 側に出す。
 * 畳むと隠れる件数は開閉状態によらず一定で、トグルは開閉のどちらでも出る。
 */
export function runRows(run: PreviewRun, expanded: boolean, revealSide: RevealSide): RunRow[] {
  const foldableCount = Math.max(run.speeches.length - run.foldedCount, 0);
  const speechRows = run.speeches.map((speech, i): RunRow => ({
    kind: "speech",
    index: run.start + i,
    speech,
  }));
  const tail = speechRows.slice(foldableCount);
  if (foldableCount === 0) return tail;

  const toggle: RunRow = { kind: "toggle", foldableCount };
  if (!expanded) return [toggle, ...tail];
  const revealed = speechRows.slice(0, foldableCount);
  return revealSide === "above" ? [...revealed, toggle, ...tail] : [toggle, ...revealed, ...tail];
}
