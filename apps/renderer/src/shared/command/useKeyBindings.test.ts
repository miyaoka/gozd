import { beforeEach, describe, expect, test } from "bun:test";
import { parseKeyStroke } from "./parseKeyStroke";
import { useCommandRegistry } from "./useCommandRegistry";
import { useContextKeys } from "./useContextKeys";
import { resolveKeyBinding } from "./useKeyBindings";

const registry = useCommandRegistry();
const contextKeys = useContextKeys();

/** 発火した keystroke で実行されるコマンド ID */
function resolvedId(key: string): string | undefined {
  return resolveKeyBinding(parseKeyStroke(key))?.id;
}

describe("resolveKeyBinding", () => {
  beforeEach(() => {
    registry.reset();
    contextKeys.reset();
  });

  test("keybinding を持たないコマンドはキーで発火しない", () => {
    registry.register("a.noKey", { label: "a", handler: () => true });

    expect(resolvedId("cmd+k")).toBeUndefined();
  });

  test("keystroke が一致する登録済みコマンドを返す", () => {
    registry.register("a.hit", {
      label: "a",
      keybinding: { key: "cmd+k" },
      handler: () => true,
    });

    expect(resolvedId("cmd+k")).toBe("a.hit");
    expect(resolvedId("cmd+j")).toBeUndefined();
  });

  test("dispose したコマンドの割り当ては消える（ID の突き合わせ先が無い状態を作れない）", () => {
    const dispose = registry.register("a.hit", {
      label: "a",
      keybinding: { key: "cmd+k" },
      handler: () => true,
    });
    dispose();

    expect(resolvedId("cmd+k")).toBeUndefined();
  });

  test("keybinding の when が偽なら発火しない", () => {
    registry.register("a.hit", {
      label: "a",
      keybinding: { key: "cmd+k", when: "terminalFocus" },
      handler: () => true,
    });

    expect(resolvedId("cmd+k")).toBeUndefined();

    contextKeys.set("terminalFocus", true);
    expect(resolvedId("cmd+k")).toBe("a.hit");
  });

  test("実効条件は precondition と when の AND", () => {
    registry.register("a.hit", {
      label: "a",
      precondition: "previewVisible",
      keybinding: { key: "cmd+k", when: "!inputFocused" },
      handler: () => true,
    });

    expect(resolvedId("cmd+k")).toBeUndefined();

    contextKeys.set("previewVisible", true);
    expect(resolvedId("cmd+k")).toBe("a.hit");

    contextKeys.set("inputFocused", true);
    expect(resolvedId("cmd+k")).toBeUndefined();
  });

  test("同一キーの割り当ては context key で排他になる（main window / child window）", () => {
    registry.register("a.main", {
      label: "a",
      keybinding: { key: "cmd+w", when: "previewVisible && !childWindowFocused" },
      handler: () => true,
    });
    registry.register("a.child", {
      label: "b",
      precondition: "childWindowFocused",
      keybinding: { key: "cmd+w" },
      handler: () => true,
    });

    contextKeys.set("previewVisible", true);
    expect(resolvedId("cmd+w")).toBe("a.main");

    contextKeys.set("childWindowFocused", true);
    expect(resolvedId("cmd+w")).toBe("a.child");
  });
});
