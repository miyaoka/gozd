import { describe, expect, test } from "bun:test";
import { eventToKeyStroke, matchKeyStroke, parseKeyStroke } from "./parseKeyStroke";

describe("parseKeyStroke", () => {
  test("英字キー", () => {
    expect(parseKeyStroke("d")).toEqual({
      code: "KeyD",
      meta: false,
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  test("数字キー", () => {
    expect(parseKeyStroke("2")).toEqual({
      code: "Digit2",
      meta: false,
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  test("矢印キー", () => {
    expect(parseKeyStroke("up").code).toBe("ArrowUp");
    expect(parseKeyStroke("down").code).toBe("ArrowDown");
    expect(parseKeyStroke("left").code).toBe("ArrowLeft");
    expect(parseKeyStroke("right").code).toBe("ArrowRight");
  });

  test("特殊キー", () => {
    expect(parseKeyStroke("enter").code).toBe("Enter");
    expect(parseKeyStroke("escape").code).toBe("Escape");
    expect(parseKeyStroke("tab").code).toBe("Tab");
    expect(parseKeyStroke("space").code).toBe("Space");
    expect(parseKeyStroke("backspace").code).toBe("Backspace");
    expect(parseKeyStroke("f1").code).toBe("F1");
    expect(parseKeyStroke("f12").code).toBe("F12");
  });

  test("記号キー", () => {
    expect(parseKeyStroke(";").code).toBe("Semicolon");
    expect(parseKeyStroke(",").code).toBe("Comma");
    expect(parseKeyStroke("-").code).toBe("Minus");
  });

  test("modifier + key", () => {
    expect(parseKeyStroke("cmd+d")).toEqual({
      code: "KeyD",
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  test("複数 modifier", () => {
    expect(parseKeyStroke("shift+cmd+d")).toEqual({
      code: "KeyD",
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
    });
    expect(parseKeyStroke("alt+cmd+up")).toEqual({
      code: "ArrowUp",
      meta: true,
      ctrl: false,
      alt: true,
      shift: false,
    });
  });

  test("modifier エイリアス", () => {
    expect(parseKeyStroke("meta+d").meta).toBe(true);
    expect(parseKeyStroke("opt+d").alt).toBe(true);
    expect(parseKeyStroke("option+d").alt).toBe(true);
    expect(parseKeyStroke("control+d").ctrl).toBe(true);
    expect(parseKeyStroke("win+d").meta).toBe(true);
  });

  test("大文字混在を許容", () => {
    expect(parseKeyStroke("Cmd+D")).toEqual(parseKeyStroke("cmd+d"));
    expect(parseKeyStroke("Shift+CMD+Up")).toEqual(parseKeyStroke("shift+cmd+up"));
  });

  test("角括弧記法で e.code を直接指定", () => {
    expect(parseKeyStroke("[BracketLeft]").code).toBe("BracketLeft");
    expect(parseKeyStroke("shift+cmd+[BracketLeft]")).toEqual({
      code: "BracketLeft",
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
    });
  });

  test("角括弧記法は大文字を保持する", () => {
    expect(parseKeyStroke("[IntlYen]").code).toBe("IntlYen");
  });

  test("末尾が modifier 名ならエラー", () => {
    expect(() => parseKeyStroke("cmd+shift")).toThrow("Key is a modifier name");
    expect(() => parseKeyStroke("ctrl")).toThrow("Key is a modifier name");
  });

  test("未知の modifier ならエラー", () => {
    expect(() => parseKeyStroke("super+d")).toThrow("Unknown modifier");
  });

  test("未知の key ならエラー", () => {
    expect(() => parseKeyStroke("cmd+unknown")).toThrow("Unknown key");
  });

  test("空文字列ならエラー", () => {
    expect(() => parseKeyStroke("")).toThrow();
  });
});

describe("eventToKeyStroke", () => {
  test("e.code をそのまま使う", () => {
    const event = { code: "KeyD", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(eventToKeyStroke(event)).toEqual({
      code: "KeyD",
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  test("Shift+2 は e.code が Digit2", () => {
    const event = { code: "Digit2", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
    expect(eventToKeyStroke(event)).toEqual({
      code: "Digit2",
      meta: false,
      ctrl: false,
      alt: false,
      shift: true,
    });
  });
});

describe("matchKeyStroke", () => {
  test("一致する", () => {
    const a = parseKeyStroke("cmd+d");
    const b = { code: "KeyD", meta: true, ctrl: false, alt: false, shift: false };
    expect(matchKeyStroke(a, b)).toBe(true);
  });

  test("code が異なれば不一致", () => {
    const a = parseKeyStroke("cmd+d");
    const b = { code: "KeyE", meta: true, ctrl: false, alt: false, shift: false };
    expect(matchKeyStroke(a, b)).toBe(false);
  });

  test("modifier が異なれば不一致", () => {
    const a = parseKeyStroke("cmd+d");
    const b = { code: "KeyD", meta: false, ctrl: false, alt: false, shift: false };
    expect(matchKeyStroke(a, b)).toBe(false);
  });

  test("config の shift+2 と e.code Digit2 + shift がマッチする", () => {
    const config = parseKeyStroke("shift+2");
    const event = eventToKeyStroke({
      code: "Digit2",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });
    expect(matchKeyStroke(config, event)).toBe(true);
  });

  test("角括弧記法と e.code がマッチする", () => {
    const config = parseKeyStroke("shift+cmd+[BracketLeft]");
    const event = eventToKeyStroke({
      code: "BracketLeft",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });
    expect(matchKeyStroke(config, event)).toBe(true);
  });
});
