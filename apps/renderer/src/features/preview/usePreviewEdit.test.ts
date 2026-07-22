/**
 * usePreviewEdit の編集セッション lifecycle を検証する。
 * 不変条件「セッションが存在 ⇔ popover 表示中 && summary 外 && 編集可能 content 表示」の
 * 「張り直し」側 (close → 再 open / summary 退出。可視状態だけが変わり content は不変) が対象。
 * content 取得層は不変条件の判定に使う ref だけを持つ fake で代替する。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, nextTick, ref } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useChangesSummaryStore } from "../changes";
import type { PreviewContent } from "./usePreviewContent";
import { usePreviewEdit } from "./usePreviewEdit";
import { usePreviewEditStore } from "./usePreviewEditStore";
import { usePreviewStore } from "./usePreviewStore";
import { useUnsavedDraftConfirm } from "./useUnsavedDraftConfirm";

const DIR = "/repo";

function createMockPopover(): HTMLElement {
  return { showPopover() {}, hidePopover() {} } as unknown as HTMLElement;
}

/** 編集可能判定 (isCodePreviewActive) を満たす最小の content fake */
function fakeContent(): PreviewContent {
  return {
    activeMode: ref("current"),
    isContentUnavailable: ref(false),
    imageSource: ref(undefined),
    displayIsBinary: ref(false),
    displayContent: ref("base"),
    fileType: ref("code"),
    previewEnabled: ref(false),
    currentContent: ref("base"),
    currentText: ref("base"),
    originalText: ref(undefined),
    isCommitMode: ref(false),
  } as unknown as PreviewContent;
}

/** a.ts を選択して preview を開き、usePreviewEdit を張る (immediate watch がセッションを張る) */
function arm() {
  const preview = usePreviewStore();
  const editStore = usePreviewEditStore();
  preview.bindPopover(createMockPopover());
  preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
  const content = fakeContent();
  effectScope().run(() => usePreviewEdit(content));
  return { preview, editStore, content };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useRepoStore().selectDir(DIR);
  useUnsavedDraftConfirm().cancel();
});

describe("usePreviewEdit セッション張り直し", () => {
  test("close で畳んだセッションを再 open で張り直し、編集が dirty になる", async () => {
    const { preview, editStore } = arm();
    expect(editStore.hasSession).toBe(true);

    preview.requestClose();
    expect(editStore.hasSession).toBe(false);
    // close と reopen は別 tick のユーザー操作。同一 tick に畳むと watch から isOpen の
    // 往復 (true→false→true) が見えず発火しないため、実際の操作列どおり tick を跨ぐ
    await nextTick();

    preview.toggle();
    await nextTick();
    expect(editStore.hasSession).toBe(true);

    editStore.updateDraft("edited");
    expect(editStore.isDirty).toBe(true);
  });

  test("Don't Save で close 後、再 open からの編集が dirty になる", async () => {
    const { preview, editStore } = arm();
    editStore.updateDraft("edited");

    preview.requestClose();
    useUnsavedDraftConfirm().chooseDiscard();
    expect(preview.isOpen).toBe(false);
    expect(editStore.hasSession).toBe(false);
    await nextTick();

    preview.toggle();
    await nextTick();
    expect(editStore.hasSession).toBe(true);
    expect(editStore.isDirty).toBe(false);

    editStore.updateDraft("edited again");
    expect(editStore.isDirty).toBe(true);
  });

  test("summary 進入で畳み、退出 (disable 単独 / popover 維持) で張り直す", async () => {
    const { preview, editStore } = arm();

    preview.openSummary();
    await nextTick();
    expect(editStore.hasSession).toBe(false);

    useChangesSummaryStore().disable();
    await nextTick();
    expect(editStore.hasSession).toBe(true);
  });

  test("popover が閉じている間は content が変わってもセッションを張らない", async () => {
    const { preview, editStore, content } = arm();
    preview.requestClose();
    expect(editStore.hasSession).toBe(false);

    // 閉じている間の外部変更追従 (fsChange 再取得) 相当
    (content.currentText as unknown as { value: string }).value = "changed externally";
    await nextTick();
    expect(editStore.hasSession).toBe(false);
  });
});
