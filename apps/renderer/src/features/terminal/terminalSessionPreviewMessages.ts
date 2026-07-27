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
 * 末尾走査における kind の役割。
 *
 * - `action`: エージェントの作業。件数に加算する
 * - `utterance`: bubble に出る発言。ここで走査を打ち切る (発言でリセット)
 * - `transparent`: 加算も打ち切りもせず読み飛ばす
 *
 * 打ち切りを `utterance` に限るのは、preview の bubble 列と件数の増減を一致させるため。
 * bubble に現れないイベントで打ち切ると、画面に何も現れないまま点の数が巻き戻る
 * (`system` は tool_use → hook attachment → tool_result の JSONL 順で tool_result 到着前に
 * 末尾へ来るため、透過しないと tool 実行中に進行中表示が消える)。
 *
 * `image` / `branch` は `parsePreview` が bubble にしないため transparent。`ask` は
 * `expandAskMessages` で user / assistant へ展開済みの前提なのでここには来ないが、
 * 未展開で渡された場合も会話イベントとして打ち切るのが自然なので utterance に置く。
 */
type ScanRole = "action" | "utterance" | "transparent";

const SCAN_ROLE: Record<TranscriptEvent["kind"], ScanRole> = {
  thinking: "action",
  tool: "action",
  user: "utterance",
  assistant: "utterance",
  teammate: "utterance",
  ask: "utterance",
  system: "transparent",
  image: "transparent",
  branch: "transparent",
};

/**
 * 直近の発言以降に積まれたアクション (thinking / tool) の件数を数える。0 なら進行中でない
 * (末尾が発言、または発言も作業もない)。1 以上ならその件数がそのまま進行中インジケータの
 * 点の数になる。
 *
 * kind ごとの扱いは `SCAN_ROLE` が SSOT。text が空文字の発言は `collectMessages` が bubble から
 * 捨てるため、打ち切らず透過する (打ち切ると bubble が現れないまま件数が巻き戻る。空文字の
 * 発言イベントは注入レコード等で実際に流れてくる)。
 */
export function countInProgressActions(events: TranscriptEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    const role = SCAN_ROLE[ev.kind];
    if (role === "transparent") continue;
    if (role === "action") {
      count++;
      continue;
    }
    if ("text" in ev && ev.text === "") continue;
    return count;
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
