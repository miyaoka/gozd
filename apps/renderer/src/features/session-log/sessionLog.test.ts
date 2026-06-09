import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import {
  buildSubagentLinks,
  buildTimelineTracks,
  expandAskMessages,
  formatModelLabel,
  formatSessionTime,
  groupByWorkflow,
  nearestEventIndexByTs,
  newestSubagentTrackId,
  parseSessionLog,
  sessionTimeRange,
  subagentTabLabel,
  timelineAxisRange,
  type SubagentDescriptor,
  type TimelineSession,
  type TranscriptEvent,
  type WorkflowGroupItem,
} from "./sessionLog";

/** 1 レコードを JSONL 1 行にする。複数行は join して渡す。 */
function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

const TS = "2026-05-31T10:00:00.000Z";

describe("parseSessionLog", () => {
  test("user の string content を user イベントにする", () => {
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content: "調べてほしい" } }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "調べてほしい", ts: TS }]);
    expect(log.totalLines).toBe(1);
  });

  test("assistant の text / thinking を個別イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "考える", signature: "x" },
            { type: "text", text: "やります" },
          ],
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "thinking", text: "考える", ts: TS },
      { kind: "assistant", text: "やります", ts: TS },
    ]);
  });

  // signature は判定に使わない (平文の有無のみで決める)。fixture の signature は
  // 実ログ形状の再現であって判定には寄与しない。
  test("平文が空文字の thinking は載せず emptyThinking に計上 (skipped とは別枠)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "encrypted-blob" },
            { type: "text", text: "やります" },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "assistant", text: "やります", ts: TS }]);
    expect(log.emptyThinking).toBe(1);
    expect(log.skipped).toBe(0);
  });

  test("thinking フィールド欠落 (signature のみ) も emptyThinking に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "thinking", signature: "encrypted-blob" }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.emptyThinking).toBe(1);
  });

  test("空白のみの thinking は平文ありとみなし表示する (空判定は厳密一致)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "  \n" }],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "thinking", text: "  \n", ts: TS }]);
    expect(log.emptyThinking).toBe(0);
  });

  test("空名 / 名前欠落の tool_use は可視マーカー (unnamed tool) に倒す", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "", input: {} }],
          },
        },
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t2", input: {} }],
          },
        },
      ),
    );
    const [empty, missing] = log.events;
    expect(empty?.kind === "tool" && empty.name).toBe("(unnamed tool)");
    expect(missing?.kind === "tool" && missing.name).toBe("(unnamed tool)");
  });

  test("input 欠落の tool_use は空 object に倒す (下流の添字アクセス保護)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash" }],
        },
      }),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.input).toEqual({});
  });

  test("tool_use と tool_result を tool_use_id でペア化する", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }],
          },
        },
      ),
    );
    expect(log.events).toEqual([
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls" },
        toolUseId: "t1",
        ts: TS,
        result: { text: "a\nb", isError: false },
      },
    ]);
  });

  test("is_error の tool_result は result.isError=true", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
          },
        },
      ),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.result).toEqual({ text: "boom", isError: true });
  });

  test("isMeta:true の user レコードは載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        isMeta: true,
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill" }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("slash command 起動はコマンド名を user イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            "<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>",
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "/review-pr", ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("slash command の引数はコマンド名の後ろに連結する", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>auto</command-args>",
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "/effort auto", ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("command-name を欠いた病的な command ブロックは載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: { role: "user", content: "<command-message>broken</command-message>" },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  // command 抽出は先頭アンカー (COMMAND_BLOCK_LEAD_RE) で採否を決めるため、本文中に
  // <command-name> を含む生発話 (このログ機能自体を議論する発話など) は切り詰めず verbatim。
  test("本文中に <command-name> を含む通常発話は切り詰めず verbatim で残す", () => {
    const content = "この <command-name>/foo</command-name> の扱いを直して";
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content } }),
    );
    expect(log.events).toEqual([{ kind: "user", text: content, ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("task-notification / system-reminder 注入 string は載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>abc</task-id>\n<result>done</result>",
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: { role: "user", content: "<system-reminder>be careful</system-reminder>" },
        },
      ),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(2);
  });

  test("SDK 合成 assistant (model:<synthetic>) は transcript に載せず skipped に計上", () => {
    // 観測形: 実 assistant 応答後に SDK が `model:"<synthetic>"` + `[{type:"text",text:"No response requested."}]`
    // を同じ親に追記する。これは実応答ではないので skipped に倒す。
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
    expect(log.models).toEqual([]);
  });

  test("先頭が注入タグでない通常発話は残す (タグが後ろに付くケース)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: "これを直して\n<system-reminder>noise</system-reminder>",
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "これを直して\n<system-reminder>noise</system-reminder>", ts: TS },
    ]);
  });

  test("親 tool_use が無い tool_result は捨てて skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("attachment / system 等の非会話レコードは skipped に計上", () => {
    const log = parseSessionLog(
      jsonl(
        { type: "attachment", timestamp: TS },
        { type: "system", subtype: "turn_duration", timestamp: TS },
      ),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(2);
  });

  test("queued_command は commandMode:prompt の生発話を user イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          prompt: "これ要らないなら消しとけ",
          commandMode: "prompt",
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "これ要らないなら消しとけ", ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("queued_command の commandMode:task-notification は載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  // commandMode を採否の SSOT にするため、本文がタグ始まりの正当な生発話 (<span> や
  // <command-name> を含む議論) を切り詰めず verbatim で出す。
  test("queued_command の commandMode:prompt はタグ始まりの本文も verbatim で出す", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: '<span class="x">Setting up...</span> を消して',
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "user", text: '<span class="x">Setting up...</span> を消して', ts: TS },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("parse 失敗行は malformed に計上し他行は継続処理", () => {
    const valid = JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { role: "user", content: "ok" },
    });
    const log = parseSessionLog(`${valid}\n{ broken json`);
    expect(log.events).toEqual([{ kind: "user", text: "ok", ts: TS }]);
    expect(log.malformed).toBe(1);
    // totalLines は表示した (live な) 行数。parse 不能行は uuid 不明で枝に帰属できないため
    // malformed に計上して totalLines からは外す (= live 1 行のみ)。
    expect(log.totalLines).toBe(1);
  });

  // rewind 分岐: assistant 応答 (a1) を親に user プロンプトが 2 つ (旧 b1 / 新 b2) 生える。
  // append-only なので b2 が最新。デフォルトは最新枝 (b2) を表示し、その直前に branch を挿す。
  const rewindLog = () =>
    jsonl(
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: TS,
        message: { role: "user", content: "?" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
      },
      // 旧枝 (rewind で捨てられた)
      {
        type: "user",
        uuid: "b1",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "週末の天気は？" },
      },
      {
        type: "assistant",
        uuid: "c1",
        parentUuid: "b1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "週末は雨" }] },
      },
      // 新枝 (最新)
      {
        type: "user",
        uuid: "b2",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "昨日の天気は？" },
      },
      {
        type: "assistant",
        uuid: "c2",
        parentUuid: "b2",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "昨日は晴れ" }] },
      },
    );

  // 観測症状: 実 assistant 応答 (b1) と SDK 合成 assistant (b2: model:<synthetic>) が同じ親 uuid に
  // 並ぶ。append-only 木の上では兄弟になるが、合成 assistant は rewind ではないため branch chooser
  // を出してはいけない (ターミナル上では分岐していないのに UI 上だけ分岐表示される症状)。
  test("rewind: SDK 合成 assistant は分岐候補から除外する", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "主要箇所の検証お願い" },
        },
        {
          type: "assistant",
          uuid: "b1",
          parentUuid: "u1",
          timestamp: TS,
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "text", text: "主要箇所の検証が完了しました。" }],
          },
        },
        {
          type: "assistant",
          uuid: "b2",
          parentUuid: "u1",
          timestamp: TS,
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
      ),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "主要箇所の検証お願い", ts: TS },
      { kind: "assistant", text: "主要箇所の検証が完了しました。", ts: TS },
    ]);
  });

  // 実観測形 (studio-front jsonl) を再現する fixture builder。AskUserQuestion 投げた直後にセッション
  // が切れ `claude --continue` 相当で resume されたケース。木の形:
  //
  //   u1 (user 生発話, candidate)
  //     ├─ a0 (assistant thinking; 最新モデルは signature のみで平文は空 → NOT candidate)
  //     │   └─ a1 (assistant text "主要箇所…", candidate)
  //     │       └─ a2 (assistant tool_use:AskUserQuestion, NOT candidate; ここで停止)
  //     └─ r1 (user "Continue from where you left off.", isMeta:true → NOT candidate)
  //         └─ r2 (assistant text "No response requested.", model = r2Model)
  //
  // 症状の消失は「r1 を弾く isMeta filter (既存) と r2 を弾く synthetic filter (本 PR で追加)」の AND
  // で初めて成立する。どちらが欠けても a1 と r2 (または r1) が `convAncestor` で u1 兄弟になり偽
  // branch chooser が浮上する。model フィールドだけ差し替えれば「synthetic filter on/off」を切り替え
  // られる作りにし、positive / contrast の 2 test で同 topology を比較する。
  const resumeMidAskFixture = (r2Model: string) =>
    jsonl(
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: TS,
        message: { role: "user", content: "投稿予定の総評本文をレビュー" },
      },
      // real chain
      {
        type: "assistant",
        uuid: "a0",
        parentUuid: "u1",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "thinking", thinking: "", signature: "redacted" }],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "a0",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "主要箇所の検証が完了しました。" }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: {} }],
        },
      },
      // resume chain: r1 は SDK 注入 (isMeta:true)、r2 が問題の synthetic
      {
        type: "user",
        uuid: "r1",
        parentUuid: "u1",
        isMeta: true,
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "text", text: "Continue from where you left off." }],
        },
      },
      {
        type: "assistant",
        uuid: "r2",
        parentUuid: "r1",
        timestamp: TS,
        message: {
          role: "assistant",
          model: r2Model,
          content: [{ type: "text", text: "No response requested." }],
        },
      },
    );

  // positive (synthetic) と contrast (実モデル) を pair で並べる。両 test は同じ topology で
  // model フィールドだけが違う。positive が本 PR の core invariant (偽 chooser 消滅) を assert し、
  // contrast は `isBranchCandidate` の synthetic 早期 return が外された場合に得られる挙動を
  // ロックして退行検出を担保する。
  //
  // contrast の expect 値は「現状の正しい挙動の spec」ではなく「本 PR で消したい症状を退行検出
  // のためにロックしているもの」。将来 resume 注入 user prompt 自体の扱いを変える等 core を深める
  // 変更を入れる際は、contrast の expect を更新する前提。
  //
  // 両 test は events だけでなく skipped / emptyThinking / models も assert することで、synthetic
  // 弾きが外れた退行時に「skipped が 2 → 1 に減る」「models[] への重複登録の有無」等の二次的な
  // 副作用も検出する。
  describe("rewind: resume mid-AskUserQuestion synthetic exclusion (regression guard pair)", () => {
    test("positive: model:<synthetic> の r2 は branch 候補から外れ偽 chooser が消える", () => {
      const log = parseSessionLog(resumeMidAskFixture("<synthetic>"));
      // AskUserQuestion は tool ではなく ask イベントとして emit される。input.questions が
      // 空 (この fixture では `input: {}`) のときも ask を作り、questions:[] のまま残す
      // (resume 中断 + 質問配列空 = 最も degenerate な ask シナリオの表現)。
      expect(log.events).toEqual([
        { kind: "user", text: "投稿予定の総評本文をレビュー", ts: TS },
        { kind: "assistant", text: "主要箇所の検証が完了しました。", ts: TS },
        {
          kind: "ask",
          ts: TS,
          toolUseId: "tu1",
          questions: [],
        },
      ]);
      // r1 (isMeta) + r2 (synthetic) が skipped に計上される。a0 の空 thinking は emptyThinking 側。
      expect(log.skipped).toBe(2);
      expect(log.emptyThinking).toBe(1);
      expect(log.models).toEqual(["claude-opus-4-7"]);
    });

    // contrast: `isBranchCandidate` の synthetic 早期 return line を外すと positive の expect
    // 結果がこの contrast 形 (偽 branch chooser 出現) に変わる。退行検出担保。
    test("contrast: r2 が実モデルだと同じ topology で偽 chooser が浮上する", () => {
      const log = parseSessionLog(resumeMidAskFixture("claude-opus-4-7"));
      expect(log.events).toEqual([
        { kind: "user", text: "投稿予定の総評本文をレビュー", ts: TS },
        {
          kind: "branch",
          ts: TS,
          branchKey: "u1",
          selectedChildUuid: "r2",
          options: [
            { childUuid: "a1", index: 1, lead: "主要箇所の検証が完了しました。", ts: TS },
            { childUuid: "r2", index: 2, lead: "No response requested.", ts: TS },
          ],
        },
        { kind: "assistant", text: "No response requested.", ts: TS },
      ]);
      // r1 (isMeta) のみ skipped。r2 は synthetic 弾きが効かないため events に乗り skipped されない。
      // 分岐確定により a1 / a2 サブツリーは prune される (a0 は分岐より上なので emptyThinking に残る)。
      expect(log.skipped).toBe(1);
      expect(log.emptyThinking).toBe(1);
      expect(log.models).toEqual(["claude-opus-4-7"]);
    });
  });

  describe("AskUserQuestion を ask イベントに畳む", () => {
    // AskUserQuestion は assistant の質問 + user の回答を 1 つの会話ブロックに畳んで扱う。
    // tool_use の input.questions[] から質問列と選択肢を抜き、後続の tool_result が来た line
    // の raw top-level `toolUseResult.answers` (構造化 Map) から answer を充填する。result が
    // 来ない (resume 中断) ケースは answer=undefined のまま残す。
    //
    // 充填ソースに `toolUseResult.answers` を使う理由: 同 line に同居する tool_result.content
    // の自然言語テキスト ("Q"="A" 形式) は質問・回答が `"` を含むと regex 復元が壊れる。
    // `answers` は Claude Code が組み立てた構造化 Map なので、信頼境界外データの任意 char
    // 集合に依存せず正しく取れる。

    /**
     * AskUserQuestion 応答 line の最小 fixture。message.content には tool_result block を、
     * top-level `toolUseResult.answers` には Q→A Map を載せる (実 jsonl の構造と一致)。
     */
    const askResultLine = (
      toolUseId: string,
      answers: Record<string, string> | undefined,
    ): unknown => ({
      type: "user",
      timestamp: TS,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "Your questions have been answered: ... (text 経路は読まない)",
          },
        ],
      },
      ...(answers !== undefined ? { toolUseResult: { answers } } : {}),
    });

    test("通常の Q/A: input から質問列を構築し toolUseResult.answers から answer を充填", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [
                      {
                        question: "日本の首都はどこ?",
                        header: "日本クイズ",
                        multiSelect: false,
                        options: [
                          { label: "京都", description: "古都" },
                          { label: "東京", description: "現首都" },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { "日本の首都はどこ?": "東京" }),
        ),
      );
      expect(log.events).toEqual([
        {
          kind: "ask",
          ts: TS,
          toolUseId: "tu1",
          questions: [
            {
              question: "日本の首都はどこ?",
              header: "日本クイズ",
              multiSelect: false,
              options: [
                { label: "京都", description: "古都" },
                { label: "東京", description: "現首都" },
              ],
              answer: "東京",
            },
          ],
        },
      ]);
    });

    test("複数 question: 各 answer を question 文字列で引き当てる", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [
                      { question: "Q1", header: "", multiSelect: false, options: [] },
                      { question: "Q2", header: "", multiSelect: false, options: [] },
                    ],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { Q1: "A1", Q2: "A2" }),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions.map((q) => q.answer)).toEqual(["A1", "A2"]);
      }
    });

    // 上流の構造化 Map を SSOT に使うため、質問・回答内部の `"` が信頼境界外データとして
    // 来ても壊れないこと。content text 経路を regex で復元すると `What is "foo"?` のような
    // 形で `?` だけが抽出される等の破綻ケースがあったが、`toolUseResult.answers` 経路に
    // 倒したことで任意 char 集合に依存しない。
    test('質問 / 回答に `"` を含んでも構造化 answers Map で正しく取れる', () => {
      const tricky = 'What is "foo"?';
      const trickyAnswer = 'answer with "quote"';
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [{ question: tricky, header: "", multiSelect: false, options: [] }],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { [tricky]: trickyAnswer }),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBe(trickyAnswer);
      }
    });

    test("result が無い (resume 中断) と answer は undefined のまま", () => {
      const log = parseSessionLog(
        jsonl({
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu1",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      question: "このまま投稿しますか?",
                      header: "次のステップ",
                      multiSelect: false,
                      options: [{ label: "このまま投稿", description: "修正なし" }],
                    },
                  ],
                },
              },
            ],
          },
        }),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBeUndefined();
        expect(ev.questions[0]?.options).toEqual([
          { label: "このまま投稿", description: "修正なし" },
        ]);
      }
    });

    // tool_result が来たが構造化 `answers` フィールドが欠落しているケース (信頼境界外
    // で起こり得る部分破損)。text 経路 fallback は持たないため `answer === undefined`
    // のままで描画側が「(no response)」を出す。silent drop ではなく可視化される。
    test("toolUseResult.answers が欠落していると answer は undefined のまま", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [{ question: "Q1", header: "", multiSelect: false, options: [] }],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", undefined),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBeUndefined();
      }
    });
  });

  describe("expandAskMessages", () => {
    test("ask を assistant (質問) と user (回答) に inline 展開し、他 kind は透過", () => {
      const events: TranscriptEvent[] = [
        { kind: "user", text: "始めて", ts: TS },
        { kind: "thinking", text: "考え中", ts: TS },
        {
          kind: "ask",
          ts: TS,
          toolUseId: "tu1",
          questions: [
            { question: "Q1", header: "", multiSelect: false, options: [], answer: "A1" },
            { question: "Q2", header: "", multiSelect: false, options: [], answer: undefined },
          ],
        },
        { kind: "assistant", text: "おわり", ts: TS },
      ];
      // ask は (Q1 → A1) + (Q2 のみ, A2 は undefined で欠落)、thinking / assistant は素通し。
      expect(expandAskMessages(events)).toEqual([
        { kind: "user", text: "始めて", ts: TS },
        { kind: "thinking", text: "考え中", ts: TS },
        { kind: "assistant", text: "Q1", ts: TS },
        { kind: "user", text: "A1", ts: TS },
        { kind: "assistant", text: "Q2", ts: TS },
        { kind: "assistant", text: "おわり", ts: TS },
      ]);
    });

    test("空 question は質問メッセージを出さない (表示できる本文無しは bubble に倒さない)", () => {
      expect(
        expandAskMessages([
          {
            kind: "ask",
            ts: TS,
            toolUseId: "tu1",
            questions: [{ question: "", header: "", multiSelect: false, options: [], answer: "A" }],
          },
        ]),
      ).toEqual([{ kind: "user", text: "A", ts: TS }]);
    });

    test("空 answer は回答メッセージを出さない", () => {
      expect(
        expandAskMessages([
          {
            kind: "ask",
            ts: TS,
            toolUseId: "tu1",
            questions: [{ question: "Q", header: "", multiSelect: false, options: [], answer: "" }],
          },
        ]),
      ).toEqual([{ kind: "assistant", text: "Q", ts: TS }]);
    });

    test("空入力は空出力", () => {
      expect(expandAskMessages([])).toEqual([]);
    });

    test("ask 不在の入力はそのまま透過する", () => {
      const events: TranscriptEvent[] = [
        { kind: "user", text: "u", ts: TS },
        { kind: "assistant", text: "a", ts: TS },
        { kind: "thinking", text: "t", ts: TS },
      ];
      expect(expandAskMessages(events)).toEqual(events);
    });
  });

  test("rewind: デフォルトは最新枝を表示し直前に branch セレクタを挿す (捨て枝は出さない)", () => {
    const log = parseSessionLog(rewindLog());
    expect(log.events).toEqual([
      { kind: "user", text: "?", ts: TS },
      { kind: "assistant", text: "どうぞ", ts: TS },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "週末の天気は？", ts: TS },
          { childUuid: "b2", index: 2, lead: "昨日の天気は？", ts: TS },
        ],
      },
      { kind: "user", text: "昨日の天気は？", ts: TS },
      { kind: "assistant", text: "昨日は晴れ", ts: TS },
    ]);
  });

  test("rewind: selection で旧枝を選ぶとその枝に差し替わる", () => {
    const log = parseSessionLog(rewindLog(), new Map([["a1", "b1"]]));
    expect(log.events).toEqual([
      { kind: "user", text: "?", ts: TS },
      { kind: "assistant", text: "どうぞ", ts: TS },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b1",
        options: [
          { childUuid: "b1", index: 1, lead: "週末の天気は？", ts: TS },
          { childUuid: "b2", index: 2, lead: "昨日の天気は？", ts: TS },
        ],
      },
      { kind: "user", text: "週末の天気は？", ts: TS },
      { kind: "assistant", text: "週末は雨", ts: TS },
    ]);
  });

  test("rewind: 存在しない childUuid 指定は最新枝にフォールバック", () => {
    const log = parseSessionLog(rewindLog(), new Map([["a1", "nonexistent"]]));
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "昨日の天気は？"]);
  });

  test("rewind 無し (uuid の 1 本道) は全件表示で branch を挿さない", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "やあ" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "こんにちは" }] },
        },
      ),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "やあ", ts: TS },
      { kind: "assistant", text: "こんにちは", ts: TS },
    ]);
  });

  test("rewind: 分岐の親が透過ノード (system) でも会話的親 (直前の assistant) を branchKey にする", () => {
    // 実ログ形: user → assistant → system → system → user×2。turn 境界の system を透過して
    // 会話的親 a1 を branchKey に解決できることを踏む。間の system は表示されず (skipped)。
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "?" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
        },
        { type: "system", uuid: "s1", parentUuid: "a1", timestamp: TS },
        { type: "system", uuid: "s2", parentUuid: "s1", timestamp: TS },
        {
          type: "user",
          uuid: "b1",
          parentUuid: "s2",
          timestamp: TS,
          message: { role: "user", content: "週末の天気は？" },
        },
        {
          type: "user",
          uuid: "b2",
          parentUuid: "s2",
          timestamp: TS,
          message: { role: "user", content: "昨日の天気は？" },
        },
      ),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "?", ts: TS },
      { kind: "assistant", text: "どうぞ", ts: TS },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "週末の天気は？", ts: TS },
          { childUuid: "b2", index: 2, lead: "昨日の天気は？", ts: TS },
        ],
      },
      { kind: "user", text: "昨日の天気は？", ts: TS },
    ]);
  });

  test("rewind: 2 つの prompt の直接親が異なっても (attachment vs system) 会話的親で 1 分岐に束ねる", () => {
    // 実ログ形 (05b08da3): assistant 応答後に rewind した 2 つの prompt が、一方は attachment、
    // 他方は system を直接親に持ち、直接 parentUuid は異なる。会話的親 a1 で束ねないと分岐が
    // 検出されず両 prompt が表示される (= 旧枝混入。本 PR が直す症状の再発)。
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "?" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
        },
        // 旧枝: prompt b1 の直接親は attachment
        { type: "attachment", uuid: "att1", parentUuid: "a1", timestamp: TS },
        {
          type: "user",
          uuid: "b1",
          parentUuid: "att1",
          timestamp: TS,
          message: { role: "user", content: "旧" },
        },
        // 新枝: prompt b2 の直接親は system
        { type: "system", uuid: "sys1", parentUuid: "a1", timestamp: TS },
        {
          type: "user",
          uuid: "b2",
          parentUuid: "sys1",
          timestamp: TS,
          message: { role: "user", content: "新" },
        },
      ),
    );
    const branches = log.events.filter((e) => e.kind === "branch");
    expect(branches).toEqual([
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "旧", ts: TS },
          { childUuid: "b2", index: 2, lead: "新", ts: TS },
        ],
      },
    ]);
    // 旧枝 b1 は表示されず、新枝 b2 のみ。
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "新"]);
  });

  test("並列 tool 呼び出しは分岐にならず全 tool を表示する (偽分岐の回帰防止)", () => {
    // 実ログ形: 1 ターンで 2 tool を呼ぶと tool_use t1 が「次の tool_use t2」と「自身の
    // tool_result r1」の 2 子を持つ。これは rewind ではない。子 2 つを分岐とみなすと本流
    // (t2 以降) を捨て枝として落とすため、tool_use / tool_result は分岐候補から外す。
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "調べて" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "a1",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t2", name: "Read", input: { file: "x" } }],
          },
        },
        {
          type: "user",
          uuid: "r1",
          parentUuid: "a1",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "out1" }],
          },
        },
        {
          type: "user",
          uuid: "r2",
          parentUuid: "a2",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t2", content: "out2" }],
          },
        },
        {
          type: "assistant",
          uuid: "a3",
          parentUuid: "r2",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "終わり" }] },
        },
      ),
    );
    // 分岐は発生しない。両 tool が結果付きで表示され、本流の text も残る。
    expect(log.events.some((e) => e.kind === "branch")).toBe(false);
    expect(log.events).toEqual([
      { kind: "user", text: "調べて", ts: TS },
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls" },
        toolUseId: "t1",
        ts: TS,
        result: { text: "out1", isError: false },
      },
      {
        kind: "tool",
        name: "Read",
        input: { file: "x" },
        toolUseId: "t2",
        ts: TS,
        result: { text: "out2", isError: false },
      },
      { kind: "assistant", text: "終わり", ts: TS },
    ]);
  });

  // ネスト分岐: 最新枝 (b2) の配下でさらに rewind して 2 段目の分岐が生じる。
  const nestedLog = () =>
    jsonl(
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: TS,
        message: { role: "user", content: "?" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
      },
      {
        type: "user",
        uuid: "b1",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "外側の旧枝" },
      },
      {
        type: "user",
        uuid: "b2",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "外側の新枝" },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "b2",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "了解" }] },
      },
      {
        type: "user",
        uuid: "c1",
        parentUuid: "a2",
        timestamp: TS,
        message: { role: "user", content: "内側の旧枝" },
      },
      {
        type: "user",
        uuid: "c2",
        parentUuid: "a2",
        timestamp: TS,
        message: { role: "user", content: "内側の新枝" },
      },
    );

  test("rewind: ネスト分岐はデフォルトで両段とも最新枝を辿り branch を 2 つ出す", () => {
    const log = parseSessionLog(nestedLog());
    const branches = log.events.filter((e) => e.kind === "branch");
    expect(branches).toEqual([
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "外側の旧枝", ts: TS },
          { childUuid: "b2", index: 2, lead: "外側の新枝", ts: TS },
        ],
      },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a2",
        selectedChildUuid: "c2",
        options: [
          { childUuid: "c1", index: 1, lead: "内側の旧枝", ts: TS },
          { childUuid: "c2", index: 2, lead: "内側の新枝", ts: TS },
        ],
      },
    ]);
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "外側の新枝", "内側の新枝"]);
  });

  test("rewind: 外側で旧枝を選ぶと内側の分岐は経路から外れ消える (分岐はノード単位で独立)", () => {
    const log = parseSessionLog(nestedLog(), new Map([["a1", "b1"]]));
    const branches = log.events.filter((e) => e.kind === "branch");
    // 外側 a1 のみ。b1 配下に分岐は無いので内側 branch は出ない。
    expect(branches.map((b) => (b.kind === "branch" ? b.branchKey : ""))).toEqual(["a1"]);
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "外側の旧枝"]);
  });

  test("base64 image block を data URL の image イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "image", ts: TS, src: "data:image/png;base64,AAAA" }]);
  });

  test("ホワイトリスト外 media_type の base64 image は src=undefined", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/svg+xml", data: "PHN2" },
            },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "image", ts: TS, src: undefined }]);
  });

  test("base64 でない image block は src=undefined", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "image", ts: TS, src: undefined }]);
  });

  test("未知の content block は events に載せず skipped に計上 (user / assistant 両方)", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "redacted_thinking", data: "xxx" },
            ],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: { role: "user", content: [{ type: "future_block_type", foo: 1 }] },
        },
      ),
    );
    expect(log.events).toEqual([{ kind: "assistant", text: "hi", ts: TS }]);
    expect(log.skipped).toBe(2);
  });

  test("空行は totalLines に数えない", () => {
    const log = parseSessionLog("\n\n");
    expect(log.totalLines).toBe(0);
    expect(log.events).toEqual([]);
  });

  test("tool_result content が text/image 以外の block は可視マーカーにする", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "X", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "text", text: "hi" },
                  { type: "image" },
                  { type: "tool_use", id: "nested", name: "Y", input: {} },
                ],
              },
            ],
          },
        },
      ),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.result?.text).toBe("hi\n[image]\n[unsupported: tool_use]");
  });
});

describe("formatSessionTime", () => {
  // now を正午に固定し today / 別日分岐を決定的にする。ts は丸 1 日 / 年単位でずらすため、
  // どの TZ でも同一インスタンスは同じカレンダー日、24h ずれは必ず別日になり境界フレークが出ない。
  // 日付文字列の区切り順は toLocaleDateString のロケール依存なので exact 比較せず、
  // 「別年は 4 桁年を含む / 同年別日は含まない」という構造で年区別を検証する。
  const NOW = new Date("2026-05-31T12:00:00.000Z");
  setSystemTime(NOW);
  afterAll(() => setSystemTime());

  test("空文字は date / time とも空", () => {
    expect(formatSessionTime("")).toEqual({ date: "", time: "" });
  });

  test("不正な ISO は date / time とも空", () => {
    expect(formatSessionTime("not-a-date")).toEqual({ date: "", time: "" });
  });

  test("今日は date 空で time のみ", () => {
    const result = formatSessionTime(NOW.toISOString());
    expect(result.date).toBe("");
    expect(result.time).not.toBe("");
  });

  test("seconds: false は時・分の 2 セグメント、true は秒を含む 3 セグメント", () => {
    const ts = NOW.toISOString();
    // 区切り文字はロケール依存なので、数値セグメント数で「分まで出す / 秒を含む」を直接検証する
    // (length 比較だと分まで落とす退行をすり抜けるため)。hour12: false なので AM/PM 由来の
    // 余分なトークンは入らない。
    const withSeconds = formatSessionTime(ts, { seconds: true }).time.match(/\d+/g) ?? [];
    const withoutSeconds = formatSessionTime(ts, { seconds: false }).time.match(/\d+/g) ?? [];
    expect(withoutSeconds).toHaveLength(2);
    expect(withSeconds).toHaveLength(3);
  });

  test("同年別日は date を持ち、4 桁年を含まない (M/D)", () => {
    const result = formatSessionTime("2026-01-15T12:00:00.000Z");
    expect(result.date).not.toBe("");
    expect(result.date).not.toContain("2026");
    expect(result.time).not.toBe("");
  });

  test("別年は date に 4 桁年を含む (YYYY/M/D)", () => {
    const result = formatSessionTime("2024-05-31T12:00:00.000Z");
    expect(result.date).toContain("2024");
    expect(result.time).not.toBe("");
  });
});

describe("buildSubagentLinks", () => {
  // tool event を 1 つ作る helper。toolUseId / name / input / result を指定する。
  function toolEvent(
    name: string,
    toolUseId: string,
    input: Record<string, unknown> = {},
    resultText?: string,
  ): TranscriptEvent {
    return {
      kind: "tool",
      name,
      input,
      toolUseId,
      ts: TS,
      result: resultText === undefined ? undefined : { text: resultText, isError: false },
    };
  }
  function sub(over: Partial<SubagentDescriptor>): SubagentDescriptor {
    return {
      id: "",
      label: "",
      name: "",
      parentToolUseId: "",
      workflowRunId: "",
      workflowName: "",
      ...over,
    };
  }

  test("Agent は tool_use.id == subagent.parentToolUseId で結ぶ", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "toolu_A")],
      [sub({ id: "agent1", label: "reviewer", parentToolUseId: "toolu_A" })],
    );
    expect(links.get("toolu_A")).toEqual({ agentId: "agent1", label: "reviewer" });
  });

  test("SendMessage は input.to == agent_id で結ぶ", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "agent1" })],
      [sub({ id: "agent1", label: "reviewer" })],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "agent1", label: "reviewer" });
  });

  test("SendMessage は input.to が agent name でも結ぶ (id 不一致時の name フォールバック)", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "reviewer" })],
      [sub({ id: "agent1", label: "PR review", name: "reviewer" })],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "agent1", label: "PR review" });
  });

  test("id を name より優先する", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "agent1" })],
      [
        sub({ id: "agent1", label: "by-id" }),
        sub({ id: "agent2", label: "by-name", name: "agent1" }),
      ],
    );
    expect(links.get("toolu_S")?.agentId).toBe("agent1");
  });

  test("同名 subagent が複数 + to が name のときはリンクを張らない (一意に決められない)", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "reviewer" })],
      [sub({ id: "agent1", name: "reviewer" }), sub({ id: "agent2", name: "reviewer" })],
    );
    expect(links.has("toolu_S")).toBe(false);
  });

  test("同名 subagent が複数でも to が id なら一意に引ける", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "agent2" })],
      [
        sub({ id: "agent1", label: "first", name: "reviewer" }),
        sub({ id: "agent2", label: "second", name: "reviewer" }),
      ],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "agent2", label: "second" });
  });

  test("parentToolUseId 空の subagent は Agent 紐付け対象から外す", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "toolu_A")],
      [sub({ id: "agent1", parentToolUseId: "" })],
    );
    expect(links.has("toolu_A")).toBe(false);
  });

  test("toolUseId 空の tool event は紐付け対象外", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "")],
      [sub({ id: "agent1", parentToolUseId: "" })],
    );
    expect(links.size).toBe(0);
  });

  test("引き当たらない to / 無関係 tool は map に入らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "missing" }), toolEvent("Read", "toolu_R")],
      [sub({ id: "agent1", name: "reviewer" })],
    );
    expect(links.size).toBe(0);
  });

  test("Workflow は result の Run ID で workflow agent 群の先頭に結ぶ (ラベルは名 + 件数)", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Workflow launched.\nRun ID: wf_abc123\n…")],
      [
        sub({ id: "ag1", workflowRunId: "wf_abc123", workflowName: "diagnose" }),
        sub({ id: "ag2", workflowRunId: "wf_abc123", workflowName: "diagnose" }),
      ],
    );
    expect(links.get("toolu_W")).toEqual({ agentId: "ag1", label: "diagnose (2)" });
  });

  test("Workflow の workflowName が空なら runId をラベル名に使う", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Run ID: wf_xyz")],
      [sub({ id: "ag1", workflowRunId: "wf_xyz" })],
    );
    expect(links.get("toolu_W")).toEqual({ agentId: "ag1", label: "wf_xyz (1)" });
  });

  test("Workflow の result が未記録ならリンクを張らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W")],
      [sub({ id: "ag1", workflowRunId: "wf_abc123" })],
    );
    expect(links.has("toolu_W")).toBe(false);
  });

  test("Workflow の result に Run ID が無ければリンクを張らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Workflow launched but no run id here")],
      [sub({ id: "ag1", workflowRunId: "wf_abc123" })],
    );
    expect(links.has("toolu_W")).toBe(false);
  });

  test("Workflow の Run ID に対応する agent が無ければリンクを張らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Run ID: wf_other")],
      [sub({ id: "ag1", workflowRunId: "wf_abc123" })],
    );
    expect(links.has("toolu_W")).toBe(false);
  });
});

describe("subagentTabLabel", () => {
  function entry(over: Partial<Parameters<typeof subagentTabLabel>[0]>) {
    return { id: "", label: "", agentType: "", phaseTitle: "", ...over };
  }

  test("phaseTitle と label が両方あれば `phaseTitle · label`", () => {
    expect(subagentTabLabel(entry({ phaseTitle: "Verify", label: "reactivity" }))).toBe(
      "Verify · reactivity",
    );
  });

  test("phaseTitle 単独でも phaseTitle を出す (label 空で取りこぼさない)", () => {
    expect(subagentTabLabel(entry({ phaseTitle: "Verify", agentType: "Explore" }))).toBe("Verify");
  });

  test("label 単独なら label", () => {
    expect(subagentTabLabel(entry({ label: "reviewer", agentType: "Explore" }))).toBe("reviewer");
  });

  test("phaseTitle / label 空なら agentType", () => {
    expect(subagentTabLabel(entry({ agentType: "Explore" }))).toBe("Explore");
  });

  test("すべて空なら agentId 先頭 8 文字", () => {
    expect(subagentTabLabel(entry({ id: "abcdef0123456789" }))).toBe("abcdef01");
  });
});

describe("groupByWorkflow", () => {
  function item(over: Partial<WorkflowGroupItem>): WorkflowGroupItem {
    return { id: "", workflowRunId: "", workflowName: "", ...over };
  }

  test("workflowRunId ごとに出現順でグループ化する", () => {
    const groups = groupByWorkflow([
      item({ id: "a1", workflowRunId: "wf_1", workflowName: "diagnose" }),
      item({ id: "a2", workflowRunId: "wf_1", workflowName: "diagnose" }),
      item({ id: "b1", workflowRunId: "wf_2", workflowName: "audit" }),
    ]);
    expect(groups).toEqual([
      {
        runId: "wf_1",
        name: "diagnose",
        agents: [
          item({ id: "a1", workflowRunId: "wf_1", workflowName: "diagnose" }),
          item({ id: "a2", workflowRunId: "wf_1", workflowName: "diagnose" }),
        ],
      },
      {
        runId: "wf_2",
        name: "audit",
        agents: [item({ id: "b1", workflowRunId: "wf_2", workflowName: "audit" })],
      },
    ]);
  });

  test("workflowRunId 空の item (非 workflow subagent) は除外する", () => {
    const groups = groupByWorkflow([
      item({ id: "plain", workflowRunId: "" }),
      item({ id: "a1", workflowRunId: "wf_1", workflowName: "diagnose" }),
    ]);
    expect(groups.map((g) => g.runId)).toEqual(["wf_1"]);
  });

  test("workflowName 空なら見出し名に runId を使う", () => {
    const groups = groupByWorkflow([item({ id: "a1", workflowRunId: "wf_1", workflowName: "" })]);
    expect(groups[0].name).toBe("wf_1");
  });

  test("先頭 agent が一貫する (buildSubagentLinks のリンク先と同一の出現順先頭)", () => {
    const groups = groupByWorkflow([
      item({ id: "first", workflowRunId: "wf_1" }),
      item({ id: "second", workflowRunId: "wf_1" }),
    ]);
    expect(groups[0].agents[0].id).toBe("first");
  });
});

describe("nearestEventIndexByTs", () => {
  function userAt(ts: string): TranscriptEvent {
    return { kind: "user", text: "x", ts };
  }

  test("最も近い ts の index を返す", () => {
    const events = [
      userAt("2026-06-01T09:00:00.000Z"),
      userAt("2026-06-01T09:06:07.000Z"),
      userAt("2026-06-01T10:00:00.000Z"),
    ];
    // SendMessage 発火 (06:06.966) の直後に注入された 06:07 のイベントへ寄せる。
    expect(nearestEventIndexByTs(events, "2026-06-01T09:06:06.966Z")).toBe(1);
  });

  test("ts 不正 / 空文字なら undefined", () => {
    expect(nearestEventIndexByTs([userAt(TS)], "")).toBeUndefined();
    expect(nearestEventIndexByTs([userAt(TS)], "not-a-date")).toBeUndefined();
  });

  test("空 events / 全 ts 不正なら undefined", () => {
    expect(nearestEventIndexByTs([], TS)).toBeUndefined();
    expect(nearestEventIndexByTs([userAt(""), userAt("bad")], TS)).toBeUndefined();
  });

  test("同値 diff のタイは最小 index を選ぶ", () => {
    const events = [userAt("2026-06-01T09:00:00.000Z"), userAt("2026-06-01T09:00:02.000Z")];
    // target はちょうど中間。両者 1000ms 差で、strict < により先(最小 index)を選ぶ。
    expect(nearestEventIndexByTs(events, "2026-06-01T09:00:01.000Z")).toBe(0);
  });
});

describe("sessionTimeRange", () => {
  function userAt(ts: string): TranscriptEvent {
    return { kind: "user", text: "x", ts };
  }

  test("順不同の ts から min start / max end を取る", () => {
    // tool イベントは result 充填の都合で ts が厳密な昇順とは限らない。順序に依存せず
    // 全件の min/max を取ることを確認する。
    const events = [
      userAt("2026-06-01T10:00:00.000Z"),
      userAt("2026-06-01T09:00:00.000Z"),
      userAt("2026-06-01T09:30:00.000Z"),
    ];
    expect(sessionTimeRange(events)).toEqual({
      startMs: Date.parse("2026-06-01T09:00:00.000Z"),
      endMs: Date.parse("2026-06-01T10:00:00.000Z"),
    });
  });

  test("ts 不正 / 空文字のイベントは除外する", () => {
    const events = [userAt(""), userAt(TS), userAt("not-a-date")];
    expect(sessionTimeRange(events)).toEqual({ startMs: Date.parse(TS), endMs: Date.parse(TS) });
  });

  test("単一イベントは start === end", () => {
    expect(sessionTimeRange([userAt(TS)])).toEqual({
      startMs: Date.parse(TS),
      endMs: Date.parse(TS),
    });
  });

  test("空 events / 全 ts 不正なら undefined", () => {
    expect(sessionTimeRange([])).toBeUndefined();
    expect(sessionTimeRange([userAt(""), userAt("bad")])).toBeUndefined();
  });
});

describe("buildTimelineTracks", () => {
  // 指定 ts のイベント列を持つ TimelineSession。ts を省くと events 空 (生存期間なし)。
  function sessionAt(id: string, label: string, ...tsList: string[]): TimelineSession {
    return { id, label, models: [], events: tsList.map((ts) => ({ kind: "user", text: "x", ts })) };
  }
  const T = (hhmm: string) => `2026-06-01T${hhmm}:00.000Z`;
  const ids = (tracks: { id: string }[]) => tracks.map((t) => t.id);

  test("main を先頭固定し subagent を生存期間開始の古い順に並べる", () => {
    const tracks = buildTimelineTracks({
      main: sessionAt("main", "Main", T("09:00"), T("11:00")),
      plainSubagents: [sessionAt("late", "B", T("10:00")), sessionAt("early", "A", T("09:30"))],
      workflowGroups: [],
    });
    expect(ids(tracks)).toEqual(["main", "early", "late"]);
    expect(tracks[0].isMain).toBe(true);
    expect(tracks[0].startMs).toBe(Date.parse(T("09:00")));
  });

  test("ts を持たない subagent は末尾へ寄せる", () => {
    const tracks = buildTimelineTracks({
      main: undefined,
      plainSubagents: [sessionAt("noTs", "N"), sessionAt("withTs", "W", T("09:00"))],
      workflowGroups: [],
    });
    expect(ids(tracks)).toEqual(["withTs", "noTs"]);
  });

  test("workflow は見出し行 + 配下 agent (古い順) を 1 単位として contiguous に並べる", () => {
    const tracks = buildTimelineTracks({
      main: sessionAt("main", "Main", T("09:00")),
      plainSubagents: [],
      workflowGroups: [
        {
          name: "wf",
          runId: "wf_1",
          agents: [sessionAt("g2", "g2", T("09:30")), sessionAt("g1", "g1", T("09:10"))],
        },
      ],
    });
    expect(ids(tracks)).toEqual(["main", "wf_1", "g1", "g2"]);
    const header = tracks[1];
    expect(header.isHeader).toBe(true);
    expect(header.label).toBe("wf");
    expect(header.startMs).toBeUndefined();
    expect(tracks[2].indent).toBe(true);
  });

  test("plain と workflow を単位の最古開始時刻で混在ソートする", () => {
    const tracks = buildTimelineTracks({
      main: undefined,
      // plain は 10:00 開始、workflow は最古 agent が 09:00 開始 → workflow 単位が先。
      plainSubagents: [sessionAt("plain", "P", T("10:00"))],
      workflowGroups: [{ name: "wf", runId: "wf_1", agents: [sessionAt("a", "a", T("09:00"))] }],
    });
    expect(ids(tracks)).toEqual(["wf_1", "a", "plain"]);
  });

  test("全 agent が ts 不在の workflow 単位は末尾へ寄せる", () => {
    const tracks = buildTimelineTracks({
      main: undefined,
      plainSubagents: [sessionAt("plain", "P", T("09:00"))],
      workflowGroups: [{ name: "wf", runId: "wf_1", agents: [sessionAt("a", "a")] }],
    });
    expect(ids(tracks)).toEqual(["plain", "wf_1", "a"]);
  });
});

describe("timelineAxisRange", () => {
  const track = (startMs: number | undefined, endMs: number | undefined) => ({
    id: "x",
    label: "x",
    isMain: false,
    isHeader: false,
    indent: false,
    models: [],
    startMs,
    endMs,
  });

  test("有効 ts を持つトラックの min start / max end を返す", () => {
    expect(timelineAxisRange([track(30, 50), track(10, 40), track(undefined, undefined)])).toEqual({
      startMs: 10,
      endMs: 50,
    });
  });

  test("有効 ts を持つトラックが無ければ undefined", () => {
    expect(timelineAxisRange([])).toBeUndefined();
    expect(timelineAxisRange([track(undefined, undefined)])).toBeUndefined();
  });
});

describe("newestSubagentTrackId", () => {
  const track = (id: string, opts: { isMain?: boolean; isHeader?: boolean } = {}) => ({
    id,
    label: id,
    isMain: opts.isMain ?? false,
    isHeader: opts.isHeader ?? false,
    indent: false,
    models: [],
    startMs: undefined,
    endMs: undefined,
  });

  test("末尾から最初の非 header・非 main トラック id を返す", () => {
    const tracks = [
      track("main", { isMain: true }),
      track("wf_1", { isHeader: true }),
      track("a"),
      track("b"),
    ];
    expect(newestSubagentTrackId(tracks)).toBe("b");
  });

  test("subagent が無ければ undefined", () => {
    expect(newestSubagentTrackId([track("main", { isMain: true })])).toBeUndefined();
    expect(newestSubagentTrackId([])).toBeUndefined();
  });
});

describe("parseSessionLog model 収集", () => {
  function assistant(model: unknown): Record<string, unknown> {
    return {
      type: "assistant",
      timestamp: TS,
      message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
    };
  }

  test("assistant の message.model を採る", () => {
    const log = parseSessionLog(jsonl(assistant("claude-opus-4-8")));
    expect(log.models).toEqual(["claude-opus-4-8"]);
  });

  test("複数 model は出現順ユニーク (/model 切り替え)", () => {
    const log = parseSessionLog(
      jsonl(
        assistant("claude-opus-4-8"),
        assistant("claude-haiku-4-5-20251001"),
        assistant("claude-opus-4-8"),
      ),
    );
    expect(log.models).toEqual(["claude-opus-4-8", "claude-haiku-4-5-20251001"]);
  });

  test("null / 空 / <synthetic> は実モデルでないため除外", () => {
    const log = parseSessionLog(
      jsonl(assistant(null), assistant(""), assistant("<synthetic>"), assistant("claude-opus-4-8")),
    );
    expect(log.models).toEqual(["claude-opus-4-8"]);
  });

  test("assistant が無ければ空配列", () => {
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content: "hi" } }),
    );
    expect(log.models).toEqual([]);
  });
});

describe("formatModelLabel", () => {
  test("既知 model を family + version に整形 (日付サフィックスは捨てる)", () => {
    expect(formatModelLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(formatModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  test("既知パターンに合わない値は生のまま返す", () => {
    expect(formatModelLabel("gpt-4o")).toBe("gpt-4o");
    expect(formatModelLabel("claude-unknown")).toBe("claude-unknown");
  });
});
