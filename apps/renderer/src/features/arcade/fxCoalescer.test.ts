import { describe, expect, test } from "bun:test";
import { createFxCoalescer } from "./fxCoalescer";

describe("createFxCoalescer", () => {
  test("同一 kind の連続発火は最初の 1 回だけ通す", () => {
    const coalescer = createFxCoalescer();
    expect(coalescer.accept("error")).toBe(true);
    expect(coalescer.accept("error")).toBe(false);
    expect(coalescer.accept("error")).toBe(false);
  });

  test("finish 後は同一 kind でも再び通す", () => {
    const coalescer = createFxCoalescer();
    coalescer.accept("error");
    coalescer.finish();
    expect(coalescer.accept("error")).toBe(true);
  });

  test("kind が変われば実行中でも通す", () => {
    const coalescer = createFxCoalescer();
    expect(coalescer.accept("warning")).toBe(true);
    expect(coalescer.accept("error")).toBe(true);
    expect(coalescer.accept("success")).toBe(true);
  });

  test("kind 差し替え後は新しい kind が畳まれ、古い kind は通る", () => {
    const coalescer = createFxCoalescer();
    coalescer.accept("error");
    coalescer.accept("success");
    expect(coalescer.accept("success")).toBe(false);
    expect(coalescer.accept("error")).toBe(true);
  });

  test("初回は finish 済みでなくても通す", () => {
    const coalescer = createFxCoalescer();
    expect(coalescer.accept("success")).toBe(true);
  });
});
