import { describe, expect, test } from "bun:test";
import { consumeAutostartHint } from "./autostartHint";

describe("consumeAutostartHint", () => {
  test("読み取ると同時に消える", () => {
    const hints: Record<string, { prompt?: string }> = { leaf: { prompt: "指示" } };

    expect(consumeAutostartHint(hints, "leaf")?.prompt).toBe("指示");
    expect(hints.leaf).toBeUndefined();
  });

  test("ヒントの無い leaf では undefined を返す", () => {
    const hints: Record<string, { prompt?: string }> = {};

    expect(consumeAutostartHint(hints, "leaf")).toBeUndefined();
  });

  test("他の leaf のヒントは消さない", () => {
    const hints: Record<string, { prompt?: string }> = { a: { prompt: "A" }, b: { prompt: "B" } };

    consumeAutostartHint(hints, "a");

    expect(hints.b?.prompt).toBe("B");
  });
});
