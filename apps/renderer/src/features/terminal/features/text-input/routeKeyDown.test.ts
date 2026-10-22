import { describe, expect, test } from "bun:test";
import { routeKeyDown } from "./routeKeyDown";

const key = (key: string, keyCode: number, isComposing = false) => ({ key, keyCode, isComposing });

describe("routeKeyDown", () => {
  test("変換中のキーは isComposing が無くても IME に任せる", () => {
    expect(routeKeyDown(key("Meta", 91), true)).toBe("ime-only");
    expect(routeKeyDown(key("Enter", 13), true)).toBe("ime-only");
  });

  test("isComposing と keyCode 229 は変換の状態を問わず IME に任せる", () => {
    expect(routeKeyDown(key("a", 65, true), false)).toBe("ime-only");
    expect(routeKeyDown(key("Process", 229), false)).toBe("ime-only");
  });

  test("Dead と AltGraph は合成を EditContext に任せる", () => {
    expect(routeKeyDown(key("Dead", 69), false)).toBe("ime-only");
    expect(routeKeyDown(key("AltGraph", 18), false)).toBe("ime-only");
  });

  test("変換外の通常のキーは xterm に渡す", () => {
    expect(routeKeyDown(key("ArrowLeft", 37), false)).toBe("xterm-first");
    expect(routeKeyDown(key("a", 65), false)).toBe("xterm-first");
    expect(routeKeyDown(key("Meta", 91), false)).toBe("xterm-first");
  });
});
