import { describe, expect, test } from "bun:test";
import {
  decideSelectAction,
  type SelectAction,
  type SelectActionInput,
} from "./decideSelectAction";

/** 4 入力 → 1 action の table driven test。8 状態 + selectedRelPath undefined の境界を網羅 */
const cases: Array<{ name: string; input: SelectActionInput; expected: SelectAction["kind"] }> = [
  // 同 path + preview 開 → summary on/off で分岐
  {
    name: "same path + preview open + summary on → exit-summary",
    input: {
      relPath: "a.ts",
      selectedRelPath: "a.ts",
      previewVisible: true,
      summaryEnabled: true,
    },
    expected: "exit-summary",
  },
  {
    name: "same path + preview open + summary off → toggle-close",
    input: {
      relPath: "a.ts",
      selectedRelPath: "a.ts",
      previewVisible: true,
      summaryEnabled: false,
    },
    expected: "toggle-close",
  },
  // 同 path + preview 閉 → summary 値に関わらず select
  {
    name: "same path + preview closed + summary on → select",
    input: {
      relPath: "a.ts",
      selectedRelPath: "a.ts",
      previewVisible: false,
      summaryEnabled: true,
    },
    expected: "select",
  },
  {
    name: "same path + preview closed + summary off → select",
    input: {
      relPath: "a.ts",
      selectedRelPath: "a.ts",
      previewVisible: false,
      summaryEnabled: false,
    },
    expected: "select",
  },
  // 別 path → 残り変数に関わらず select
  {
    name: "different path + preview open + summary on → select",
    input: {
      relPath: "b.ts",
      selectedRelPath: "a.ts",
      previewVisible: true,
      summaryEnabled: true,
    },
    expected: "select",
  },
  {
    name: "different path + preview open + summary off → select",
    input: {
      relPath: "b.ts",
      selectedRelPath: "a.ts",
      previewVisible: true,
      summaryEnabled: false,
    },
    expected: "select",
  },
  {
    name: "different path + preview closed + summary on → select",
    input: {
      relPath: "b.ts",
      selectedRelPath: "a.ts",
      previewVisible: false,
      summaryEnabled: true,
    },
    expected: "select",
  },
  {
    name: "different path + preview closed + summary off → select",
    input: {
      relPath: "b.ts",
      selectedRelPath: "a.ts",
      previewVisible: false,
      summaryEnabled: false,
    },
    expected: "select",
  },
  // 境界: selectedRelPath undefined (selection 未選択 / absolute 選択中)
  {
    name: "selectedRelPath undefined + preview open → select",
    input: {
      relPath: "a.ts",
      selectedRelPath: undefined,
      previewVisible: true,
      summaryEnabled: false,
    },
    expected: "select",
  },
  {
    name: "selectedRelPath undefined + preview closed → select",
    input: {
      relPath: "a.ts",
      selectedRelPath: undefined,
      previewVisible: false,
      summaryEnabled: false,
    },
    expected: "select",
  },
];

describe("decideSelectAction", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(decideSelectAction(c.input).kind).toBe(c.expected);
    });
  }
});
