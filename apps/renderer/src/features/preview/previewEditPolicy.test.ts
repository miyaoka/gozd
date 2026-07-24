import { describe, expect, test } from "bun:test";
import {
  isCodePreviewActive,
  isDiffPreviewActive,
  isEditablePreview,
  resolveSessionTarget,
  type PreviewContentSnapshot,
  type SessionSyncInput,
} from "./previewEditPolicy";

/** 編集可能判定を満たす基準 snapshot。各テストが 1 要素だけ崩して境界を検証する */
function editableSnapshot(overrides?: Partial<PreviewContentSnapshot>): PreviewContentSnapshot {
  return {
    isContentUnavailable: false,
    activeMode: "current",
    hasImage: false,
    displayIsBinary: false,
    fileType: "code",
    previewEnabled: false,
    hasDisplayContent: true,
    hasOriginalText: false,
    hasCurrentText: true,
    ...overrides,
  };
}

function syncInput(overrides?: Partial<SessionSyncInput>): SessionSyncInput {
  return {
    open: true,
    summaryEnabled: false,
    editable: true,
    text: "base",
    selection: { kind: "worktreeRelative" },
    dir: "/repo",
    relPath: "a.ts",
    ...overrides,
  };
}

describe("isCodePreviewActive", () => {
  test("current モードのテキスト表示で true", () => {
    expect(isCodePreviewActive(editableSnapshot())).toBe(true);
  });

  test("current 以外のモード (original / diff) は履歴・比較表示のため false", () => {
    expect(isCodePreviewActive(editableSnapshot({ activeMode: "original" }))).toBe(false);
    expect(isCodePreviewActive(editableSnapshot({ activeMode: "diff" }))).toBe(false);
  });

  test("content 不在 / 画像 / バイナリは false", () => {
    expect(isCodePreviewActive(editableSnapshot({ isContentUnavailable: true }))).toBe(false);
    expect(isCodePreviewActive(editableSnapshot({ hasImage: true }))).toBe(false);
    expect(isCodePreviewActive(editableSnapshot({ displayIsBinary: true }))).toBe(false);
    expect(isCodePreviewActive(editableSnapshot({ hasDisplayContent: false }))).toBe(false);
  });

  test("markdown / html は preview 表示中のみ false (ソース表示なら編集可)", () => {
    expect(
      isCodePreviewActive(editableSnapshot({ fileType: "markdown", previewEnabled: true })),
    ).toBe(false);
    expect(
      isCodePreviewActive(editableSnapshot({ fileType: "markdown", previewEnabled: false })),
    ).toBe(true);
    expect(isCodePreviewActive(editableSnapshot({ fileType: "html", previewEnabled: true }))).toBe(
      false,
    );
  });
});

describe("isDiffPreviewActive", () => {
  test("diff モードで両テキストが揃うと true", () => {
    expect(
      isDiffPreviewActive(editableSnapshot({ activeMode: "diff", hasOriginalText: true })),
    ).toBe(true);
  });

  test("片側でもテキストが欠けると false (バイナリ diff は成立しない)", () => {
    expect(
      isDiffPreviewActive(editableSnapshot({ activeMode: "diff", hasOriginalText: false })),
    ).toBe(false);
    expect(
      isDiffPreviewActive(
        editableSnapshot({ activeMode: "diff", hasOriginalText: true, hasCurrentText: false }),
      ),
    ).toBe(false);
  });

  test("content 不在 / diff 以外のモードは false (isCodePreviewActive と境界を揃える)", () => {
    expect(
      isDiffPreviewActive(
        editableSnapshot({ activeMode: "diff", hasOriginalText: true, isContentUnavailable: true }),
      ),
    ).toBe(false);
    expect(
      isDiffPreviewActive(editableSnapshot({ activeMode: "current", hasOriginalText: true })),
    ).toBe(false);
  });
});

describe("isEditablePreview", () => {
  const gate = { selectionKind: "worktreeRelative", isCommitMode: false, prDiffOn: false } as const;

  test("worktreeRelative 選択 + current テキストで true", () => {
    expect(isEditablePreview(gate, editableSnapshot())).toBe(true);
  });

  test("選択なしは false", () => {
    expect(isEditablePreview({ ...gate, selectionKind: undefined }, editableSnapshot())).toBe(
      false,
    );
  });

  test("worktreeRelative は commit / PR diff モードで false (履歴表示は編集対象外)", () => {
    expect(isEditablePreview({ ...gate, isCommitMode: true }, editableSnapshot())).toBe(false);
    expect(isEditablePreview({ ...gate, prDiffOn: true }, editableSnapshot())).toBe(false);
  });

  test("absolute は git 文脈を持たないため commit / PR diff モードでも編集可", () => {
    const absoluteGate = {
      selectionKind: "absolute",
      isCommitMode: true,
      prDiffOn: true,
    } as const;
    expect(isEditablePreview(absoluteGate, editableSnapshot())).toBe(true);
  });
});

describe("resolveSessionTarget", () => {
  test("表示中 + summary 外 + 編集可能 + テキストありで worktreeRelative target を返す", () => {
    expect(resolveSessionTarget(syncInput())).toEqual({
      kind: "worktreeRelative",
      dir: "/repo",
      relPath: "a.ts",
    });
  });

  test("不変条件のいずれかが欠けると張らない (close / summary 進入 / 編集不可 / テキスト不在)", () => {
    expect(resolveSessionTarget(syncInput({ open: false }))).toBeUndefined();
    expect(resolveSessionTarget(syncInput({ summaryEnabled: true }))).toBeUndefined();
    expect(resolveSessionTarget(syncInput({ editable: false }))).toBeUndefined();
    expect(resolveSessionTarget(syncInput({ text: undefined }))).toBeUndefined();
  });

  test("absolute 選択は absPath を target にする (dir / relPath 不要)", () => {
    expect(
      resolveSessionTarget(
        syncInput({
          selection: { kind: "absolute", absPath: "/etc/config.json" },
          dir: undefined,
          relPath: undefined,
        }),
      ),
    ).toEqual({ kind: "absolute", absPath: "/etc/config.json" });
  });

  test("worktreeRelative で dir / relPath が解決できなければ張らない", () => {
    expect(resolveSessionTarget(syncInput({ dir: undefined }))).toBeUndefined();
    expect(resolveSessionTarget(syncInput({ relPath: undefined }))).toBeUndefined();
  });
});
