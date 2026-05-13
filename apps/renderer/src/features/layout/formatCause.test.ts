import { describe, expect, test } from "bun:test";
import { formatCauseChain } from "./formatCause";

describe("formatCauseChain", () => {
  test("単一 Error は 1 段だけ展開する", () => {
    const e = new Error("boom");
    const out = formatCauseChain(e);
    expect(out.startsWith("Error: boom")).toBe(true);
    expect(out.includes("Caused by:")).toBe(false);
  });

  test("Error.cause が Error なら chain を Caused by: で連結する", () => {
    const inner = new Error("inner reason");
    const outer = new Error("outer summary", { cause: inner });
    const out = formatCauseChain(outer);
    expect(out.startsWith("Error: outer summary")).toBe(true);
    expect(out.includes("\n\nCaused by: Error: inner reason")).toBe(true);
  });

  test("3 段の chain も全部辿る", () => {
    // 一意な marker 文字列で位置検査する。stack の file path に出ない pattern にする。
    const a = new Error("level-aaa");
    const b = new Error("level-bbb", { cause: a });
    const c = new Error("level-ccc", { cause: b });
    const out = formatCauseChain(c);
    expect(out.indexOf("level-ccc")).toBeLessThan(out.indexOf("level-bbb"));
    expect(out.indexOf("level-bbb")).toBeLessThan(out.indexOf("level-aaa"));
    // Caused by: は 2 個出現（c→b と b→a）
    expect(out.split("Caused by:").length - 1).toBe(2);
  });

  test("Error.cause が string なら 1 段降りて文字列として表示する", () => {
    const e = new Error("outer", { cause: "raw string cause" });
    const out = formatCauseChain(e);
    expect(out.startsWith("Error: outer")).toBe(true);
    expect(out.includes("Caused by: raw string cause")).toBe(true);
  });

  test("非 Error の cause（string）は 1 段で終了", () => {
    const out = formatCauseChain("just a string");
    expect(out).toBe("just a string");
  });

  test("undefined cause は空文字を返す (toast が detail を表示しない契約)", () => {
    expect(formatCauseChain(undefined)).toBe("");
  });

  test("循環参照（自己 cause）は [Circular cause] で打ち切る", () => {
    const a = new Error("self-referencing");
    Object.defineProperty(a, "cause", { value: a, enumerable: false });
    const out = formatCauseChain(a);
    expect(out.startsWith("Error: self-referencing")).toBe(true);
    expect(out.includes("[Circular cause]")).toBe(true);
  });

  test("V8 形式 stack の先頭 `name: message` 行は head と二重表示しない", () => {
    const e = new Error("msg");
    e.stack = "Error: msg\n    at frame1\n    at frame2";
    const out = formatCauseChain(e);
    // "Error: msg" は head に 1 回だけ、stack 側の同じ行はカットされている
    expect(out.match(/Error: msg/g)?.length).toBe(1);
    expect(out.includes("at frame1")).toBe(true);
    expect(out.includes("at frame2")).toBe(true);
  });

  test("WebKit 形式 stack（先頭 `name:` 行なし）はそのままフレームを後置", () => {
    const e = new Error("msg");
    e.stack = "frame1@file.js:1\nframe2@file.js:2";
    const out = formatCauseChain(e);
    expect(out.startsWith("Error: msg\nframe1@file.js:1\nframe2@file.js:2")).toBe(true);
  });

  test("aggregate 構造（外側 message に summary、cause に first.error）でも各段が読める", () => {
    // useFsWatchSync の runOneSyncPass が作る形を模倣:
    //   notify.error("Failed to sync FS watches (1)", aggregate)
    //   aggregate = new Error(summary, { cause: first.error })
    // SFC は cause 引数 = aggregate を formatCauseChain に渡す。
    const firstError = new Error("watch failed: /r1/wt-a");
    const aggregate = new Error("watch:/r1/wt-a", { cause: firstError });
    const out = formatCauseChain(aggregate);
    expect(out.includes("Error: watch:/r1/wt-a")).toBe(true);
    expect(out.includes("Caused by: Error: watch failed: /r1/wt-a")).toBe(true);
  });
});
