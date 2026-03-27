import { describe, expect, test } from "bun:test";
import { extractFirstSentence, extractSpeechText } from "./speechText";

describe("extractFirstSentence", () => {
  test("一行目の句点までを返す", () => {
    expect(extractFirstSentence("修正しました。次のステップに進みます。")).toBe("修正しました。");
  });

  test("句点がなければ一行目全体を返す", () => {
    expect(extractFirstSentence("Done")).toBe("Done");
  });

  test("空行をスキップして最初の非空行を使う", () => {
    expect(extractFirstSentence("\n\n修正しました。残りは後で。")).toBe("修正しました。");
  });

  test("マークダウン記法を除去する", () => {
    expect(extractFirstSentence("**修正**しました。次へ。")).toBe("修正しました。");
  });

  test("句点が行頭にある場合", () => {
    expect(extractFirstSentence("。後続テキスト")).toBe("。");
  });

  test("二行目以降の句点は無視する", () => {
    expect(extractFirstSentence("First line\n二行目です。")).toBe("First line");
  });

  test("空文字列は undefined を返す", () => {
    expect(extractFirstSentence("")).toBeUndefined();
  });

  test("空行のみは undefined を返す", () => {
    expect(extractFirstSentence("\n\n\n")).toBeUndefined();
  });
});

describe("extractSpeechText", () => {
  test("done イベントで last_assistant_message の一文目を返す", () => {
    expect(
      extractSpeechText("done", {
        last_assistant_message: "ファイルを更新しました。確認してください。",
      }),
    ).toBe("ファイルを更新しました。");
  });

  test("done イベントで last_assistant_message がなければ undefined", () => {
    expect(extractSpeechText("done", {})).toBeUndefined();
  });

  test("needs-input イベントで AskUserQuestion の question を返す", () => {
    expect(
      extractSpeechText("needs-input", {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "続けますか？" }],
        },
      }),
    ).toBe("続けますか？");
  });

  test("needs-input イベントで AskUserQuestion の複数文質問も句点で区切る", () => {
    expect(
      extractSpeechText("needs-input", {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "方針Aと方針Bがあります。どちらを選びますか。" }],
        },
      }),
    ).toBe("方針Aと方針Bがあります。");
  });

  test("needs-input イベントで AskUserQuestion 以外は tool_name を返す", () => {
    expect(
      extractSpeechText("needs-input", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    ).toBe("Bash");
  });

  test("対象外イベントは undefined を返す", () => {
    expect(extractSpeechText("running", {})).toBeUndefined();
  });
});
