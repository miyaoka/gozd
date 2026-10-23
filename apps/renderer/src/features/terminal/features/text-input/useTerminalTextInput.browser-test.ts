import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { effectScope, type EffectScope } from "vue";
import { isIMEActive } from "../../../../shared/command";
import { useTerminalTextInput } from "./useTerminalTextInput";
import { createXtermInputPort } from "./xtermInputPort";

/**
 * 入力面を付けた実 xterm に、DevTools Protocol で実際の変換とキー入力を起こし、端末へ届く
 * データ（onData）を確かめる。CDP の変換は文節の情報を渡さないため、下線は合成した
 * textformatupdate で確かめる。
 *
 * xtermInputPort は xterm の非公開内部に依存する。xterm を更新してここが落ちたら、その依存が
 * 崩れた合図。
 */

type KeySpec = { key: string; code: string; keyCode: number; text?: string; modifiers?: number };

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

let container: HTMLElement;
let term: Terminal;
let scope: EffectScope;
let sent: string[];
let focusEvents: string[];

beforeEach(() => {
  container = document.createElement("div");
  container.style.width = "800px";
  container.style.height = "400px";
  document.body.append(container);
  term = new Terminal();
  term.open(container);
  sent = [];
  focusEvents = [];
  term.onData((d) => sent.push(d));
  scope = effectScope();
  scope.run(() =>
    useTerminalTextInput(term, {
      onFocus: () => focusEvents.push("focus"),
      onBlur: () => focusEvents.push("blur"),
    }),
  );
  term.focus();
});

afterEach(() => {
  scope.stop();
  term.dispose();
  container.remove();
});

function host(): HTMLElement {
  const el = container.querySelector<HTMLElement>("._terminal-text-input");
  if (el === null) throw new Error("host not found");
  return el;
}

const compose = (text: string) =>
  cdp().send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });

async function press(spec: KeySpec) {
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    modifiers: spec.modifiers ?? 0,
  };
  // text を伴うキーは keyDown（文字入力を起こす）、伴わないキーは rawKeyDown で送る
  await cdp().send(
    "Input.dispatchKeyEvent",
    spec.text === undefined
      ? { type: "rawKeyDown", ...base }
      : { type: "keyDown", ...base, text: spec.text },
  );
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** ⌘+key に編集コマンド（copy / paste）を結び付けて送る。CDP のキーは既定ではコマンドを起こさない */
async function sendEditCommand(key: string, command: "copy" | "paste") {
  const base = {
    key,
    code: `Key${key.toUpperCase()}`,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  };
  await cdp().send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...base,
    modifiers: MODIFIER.meta,
    commands: [command],
  });
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** xterm の CompositionHelper などの setTimeout(0) を待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("焦点", () => {
  test("terminal.focus() は入力面に焦点を当て、xterm は焦点ありとして描く", () => {
    expect(document.activeElement).toBe(host());
    expect(term.element?.classList.contains("focus")).toBe(true);
    expect(focusEvents).toEqual(["focus"]);
    term.blur();
    expect(document.activeElement).not.toBe(host());
    expect(term.element?.classList.contains("focus")).toBe(false);
    expect(focusEvents).toEqual(["focus", "blur"]);
  });

  test("前の要素から Tab で端末へ焦点を移せ、xterm の textarea は経由しない", async () => {
    const before = document.createElement("button");
    container.before(before);
    before.focus();
    const focused: EventTarget[] = [];
    const record = (e: FocusEvent) => {
      if (e.target !== null) focused.push(e.target);
    };
    document.addEventListener("focusin", record);
    await press({ key: "Tab", code: "Tab", keyCode: 9 });
    document.removeEventListener("focusin", record);
    // textarea が焦点を受けると、xterm の keyup が入力面へ移すまでの間 textarea が入力を受ける
    expect(focused).toEqual([host()]);
    before.remove();
  });

  test("焦点報告モードでは焦点の出入りを端末へ送る", async () => {
    await new Promise<void>((resolve) => term.write("\x1b[?1004h", resolve));
    term.blur();
    term.focus();
    // 先頭はモードを有効にした時点の焦点状態の報告（xterm の要素の focus class から作られる）
    expect(sent).toEqual(["\x1b[I", "\x1b[O", "\x1b[I"]);
  });
});

describe("IME", () => {
  test("変換中の文字列を描き、確定した文字列だけが 1 回届く", async () => {
    await compose("a");
    await compose("ab");
    expect(host().textContent).toBe("ab");
    expect(host().hasAttribute("data-ime-composing")).toBe(true);
    await compose("abc");
    await cdp().send("Input.insertText", { text: "abc" });
    await settle();
    expect(sent).toEqual(["abc"]);
    expect(host().textContent).toBe("");
    expect(host().hasAttribute("data-ime-composing")).toBe(false);
    expect(host().editContext?.text).toBe("");
  });

  test("変換中の ⌘ の keydown をキーバインドは変換中として扱う", async () => {
    // CDP から送る変換中の ⌘ の keydown は isComposing を持たずに届く
    const seen: boolean[] = [];
    const listener = (e: KeyboardEvent) => {
      if (e.key === "k") seen.push(isIMEActive(e));
    };
    document.addEventListener("keydown", listener, { capture: true });
    await compose("きょう");
    await press({ key: "k", code: "KeyK", keyCode: 75, modifiers: MODIFIER.meta });
    document.removeEventListener("keydown", listener, { capture: true });
    expect(seen).toEqual([true]);
  });

  test("変換中の Enter は端末に CR を送らない", async () => {
    await compose("きょう");
    await press({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
    await cdp().send("Input.insertText", { text: "今日" });
    await settle();
    expect(sent).toEqual(["今日"]);
  });

  /** 文節 2 つ（太い下線・細い下線）の変換中の状態を作り、描かれた span を返す */
  function composeClauses(): HTMLSpanElement[] {
    const ec = host().editContext;
    if (ec === null) throw new Error("no EditContext");
    ec.dispatchEvent(new Event("compositionstart"));
    ec.updateText(0, 0, "今日はいい天気");
    ec.dispatchEvent(new Event("textupdate"));
    const formats = [
      { rangeStart: 0, rangeEnd: 3, underlineStyle: "solid", underlineThickness: "thick" },
      { rangeStart: 3, rangeEnd: 7, underlineStyle: "solid", underlineThickness: "thin" },
    ];
    const formatEvent = Object.assign(new Event("textformatupdate"), {
      getTextFormats: () => formats,
    });
    ec.dispatchEvent(formatEvent);
    return [...host().querySelectorAll("span")];
  }

  test("文節の太さに合わせて下線の太さを描き分ける", () => {
    const spans = composeClauses().map((s) => [
      s.textContent,
      getComputedStyle(s).textDecorationLine,
      getComputedStyle(s).textDecorationThickness,
    ]);
    expect(spans).toEqual([
      ["今日は", "underline", "2px"],
      ["いい天気", "underline", "1px"],
    ]);
  });

  test("変換中の下線は文字の形で途切れない", () => {
    const skipInk = composeClauses().map((s) => getComputedStyle(s).textDecorationSkipInk);
    expect(skipInk).toEqual(["none", "none"]);
  });
});

describe("キー", () => {
  test("端末シーケンスに変わるキーは xterm の変換で 1 回だけ届く", async () => {
    await press({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 });
    await press({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
    await press({ key: "Backspace", code: "Backspace", keyCode: 8 });
    await press({ key: "c", code: "KeyC", keyCode: 67, modifiers: MODIFIER.ctrl });
    await settle();
    expect(sent).toEqual(["\x1b[D", "\r", "\x7f", "\x03"]);
  });

  test("印字文字は xterm が送るものも EditContext から送るものも 1 回だけ届く", async () => {
    // 小文字は xterm が送り、Shift の大文字は xterm が引き受けず EditContext から届く
    await press({ key: "x", code: "KeyX", keyCode: 88, text: "x" });
    await press({ key: "X", code: "KeyX", keyCode: 88, text: "X", modifiers: MODIFIER.shift });
    await press({ key: " ", code: "Space", keyCode: 32, text: " " });
    await settle();
    expect(sent).toEqual(["x", "X", " "]);
    expect(host().editContext?.text).toBe("");
  });

  test("customKeyEventHandler が false を返したキーは xterm も EditContext も送らない", async () => {
    const handled: string[] = [];
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.key === "Enter" && ev.shiftKey) {
        handled.push("shift-enter");
        return false;
      }
      // 印字文字を消費したときも、EditContext に文字ができてはいけない
      if (ev.key === "Q") {
        handled.push("Q");
        return false;
      }
      return true;
    });
    await press({
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      text: "\r",
      modifiers: MODIFIER.shift,
    });
    await press({ key: "Q", code: "KeyQ", keyCode: 81, text: "Q", modifiers: MODIFIER.shift });
    await settle();
    expect(handled).toEqual(["shift-enter", "Q"]);
    expect(sent).toEqual([]);
  });
});

describe("クリップボード", () => {
  test("貼り付けは xterm の paste 処理だけが 1 回送り、EditContext には入らない", async () => {
    // 合成した paste イベントでは既定動作が起きないので、実際の Cmd+V を送る
    // テストの iframe からは navigator.clipboard に書けないので、実際のコピー操作で載せる
    const source = document.createElement("textarea");
    source.value = "pasted";
    document.body.append(source);
    source.select();
    await sendEditCommand("c", "copy");
    source.remove();
    term.focus();
    await sendEditCommand("v", "paste");
    await settle();
    expect(sent).toEqual(["pasted"]);
    expect(host().editContext?.text).toBe("");
  });

  test("入力面での Cmd+C は xterm の選択をクリップボードに載せる", async () => {
    await new Promise<void>((resolve) => term.write("hello", resolve));
    term.selectAll();
    await sendEditCommand("c", "copy");
    // クリップボードの中身は、textarea へ実際に貼り付けて読む
    const target = document.createElement("textarea");
    document.body.append(target);
    target.focus();
    await sendEditCommand("v", "paste");
    expect(target.value.trim()).toBe("hello");
    target.remove();
  });
});

test("xterm の内部の形が違えば入力面は作れない", () => {
  const fake = { _core: {}, textarea: document.createElement("textarea") } as unknown as Terminal;
  expect(() => createXtermInputPort(fake)).toThrow("xterm internals changed");
});
