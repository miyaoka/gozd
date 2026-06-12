// TerminalSessionPreview の bubble 選択ロジック。session ログの会話イベント列から
// 「応答 (run) 単位」で preview に出すメッセージを選ぶ純粋関数。SFC から分離して
// 回帰テスト (collectMessages.test.ts 相当) を書けるようにしている。

// parseSessionLog の events から user / assistant のみ残した会話イベント。
export interface PreviewEvent {
  kind: "user" | "assistant";
  text: string;
  ts: string;
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
