import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../shared/repo";
import { useChangesSummaryStore } from "../changes";
import { useWorktreeStore } from "../worktree";
import { usePreviewStore } from "./usePreviewStore";

/**
 * `previewStore.requestSelect` / `forceSelect` の決定論理だけを検証する。
 * popover DOM は最小モックを bindPopover に流して `showPopover` / `hidePopover` の呼び出しを
 * 観察可能化する（bun test は jsdom なしで動くため HTMLElement の popover API は使えない）。
 */
const DIR = "/repo";

interface MockPopover {
  showCount: number;
  hideCount: number;
  el: HTMLElement;
}

function createMockPopover(): MockPopover {
  const state: MockPopover = {
    showCount: 0,
    hideCount: 0,
    el: undefined as unknown as HTMLElement,
  };
  state.el = {
    showPopover() {
      state.showCount++;
    },
    hidePopover() {
      state.hideCount++;
    },
  } as unknown as HTMLElement;
  return state;
}

beforeEach(() => {
  setActivePinia(createPinia());
  const repoStore = useRepoStore();
  repoStore.selectDir(DIR);
});

describe("usePreviewStore.requestSelect", () => {
  test("selection 未確立 + closed → select + open", () => {
    const preview = usePreviewStore();
    const wt = useWorktreeStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });

    expect(wt.selectedRelPath).toBe("a.ts");
    expect(preview.isOpen).toBe(true);
    expect(popover.showCount).toBe(1);
    expect(popover.hideCount).toBe(0);
  });

  test("別 path + 開 → select + open は冪等（show は再呼び出しなし）", () => {
    const preview = usePreviewStore();
    const wt = useWorktreeStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    preview.requestSelect({ kind: "worktreeRelative", relPath: "b.ts" });

    expect(wt.selectedRelPath).toBe("b.ts");
    expect(preview.isOpen).toBe(true);
    expect(popover.showCount).toBe(1); // 既に open なので open() は no-op
  });

  test("同 path + 開 + summary 非表示 → close（トグル close）", () => {
    const preview = usePreviewStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(preview.isOpen).toBe(true);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(preview.isOpen).toBe(false);
    expect(popover.hideCount).toBe(1);
  });

  test("同 path + 開 + summary 表示中 → summary を抜けて preview は開いたまま", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    summary.enable();
    expect(summary.enabled).toBe(true);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(summary.enabled).toBe(false);
    expect(preview.isOpen).toBe(true);
    expect(popover.hideCount).toBe(0); // close は呼ばれない
  });

  test("同 path + closed → select + open（closed 状態では同 path でもトグル close せず開く）", () => {
    const preview = usePreviewStore();
    const wt = useWorktreeStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    preview.close();
    expect(preview.isOpen).toBe(false);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(wt.selectedRelPath).toBe("a.ts");
    expect(preview.isOpen).toBe(true);
  });

  test("absolute path も kind + path で同一性判定される", () => {
    const preview = usePreviewStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "absolute", absPath: "/etc/hosts" });
    expect(preview.isOpen).toBe(true);

    // 同一 absolute path で再呼び出し → close
    preview.requestSelect({ kind: "absolute", absPath: "/etc/hosts" });
    expect(preview.isOpen).toBe(false);
  });

  test("kind が異なれば同 path 文字列でも別 target として扱う（select + open）", () => {
    const preview = usePreviewStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });

    // 同じ文字列だが kind が違うので別 target → close せず select + open（既に開いてるので open は no-op）
    preview.requestSelect({ kind: "absolute", absPath: "a.ts" });
    expect(preview.isOpen).toBe(true);
  });

  test("正規化境界: `./a.ts` 再選択は正規化済 `a.ts` selection と同一として close", () => {
    const preview = usePreviewStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(preview.isOpen).toBe(true);

    // 未正規化な入力 (`./a.ts`) を渡しても selection (`a.ts`) と同一判定されて close する
    preview.requestSelect({ kind: "worktreeRelative", relPath: "./a.ts" });
    expect(preview.isOpen).toBe(false);
    expect(popover.hideCount).toBe(1);
  });

  test("popover 未 bind 状態では open() は no-op で isOpen も false のまま", () => {
    const preview = usePreviewStore();
    // bindPopover を呼ばない

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(preview.isOpen).toBe(false);
  });
});

describe("usePreviewStore.forceSelect", () => {
  test("同 path + 開 でも close しない（always open 契約）", () => {
    const preview = usePreviewStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.forceSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(preview.isOpen).toBe(true);

    preview.forceSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(preview.isOpen).toBe(true);
    expect(popover.hideCount).toBe(0);
  });

  test("summary 表示中でも close せず summary を維持", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.forceSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    summary.enable();

    preview.forceSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(summary.enabled).toBe(true);
    expect(preview.isOpen).toBe(true);
  });

  test("別 path への forceSelect は selection 切替 + 開いたまま", () => {
    const preview = usePreviewStore();
    const wt = useWorktreeStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.forceSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    preview.forceSelect({ kind: "worktreeRelative", relPath: "b.ts" });

    expect(wt.selectedRelPath).toBe("b.ts");
    expect(preview.isOpen).toBe(true);
    expect(popover.showCount).toBe(1);
  });
});

describe("usePreviewStore dir watch", () => {
  test("dir 切替で preview が auto-close され selection も同期で clear される（watch 登録順 pin）", () => {
    const repoStore = useRepoStore();
    const wt = useWorktreeStore();
    const preview = usePreviewStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });
    expect(wt.selection).toBeDefined();
    expect(preview.isOpen).toBe(true);

    // 別 dir に切替。useWorktreeStore 内部 dir watch (selection clear) と
    // usePreviewStore 内部 dir watch (close) は両方 flush:'sync'。両者が同一 sync tick で
    // 消化されることで、最終状態で「selection 空 + preview 閉」が揃う契約を pin する。
    repoStore.selectDir("/other-repo");
    expect(wt.selection).toBeUndefined();
    expect(preview.isOpen).toBe(false);
    expect(popover.hideCount).toBe(1);
  });
});

describe("usePreviewStore dir 未確立ガード", () => {
  test("dir 未確立で requestSelect を呼んでも preview は開かない", () => {
    setActivePinia(createPinia());
    // repoStore.selectDir を呼ばない → dir undefined のまま
    const preview = usePreviewStore();
    const wt = useWorktreeStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.requestSelect({ kind: "worktreeRelative", relPath: "a.ts" });

    expect(wt.selection).toBeUndefined();
    expect(preview.isOpen).toBe(false);
    expect(popover.showCount).toBe(0);
  });

  test("dir 未確立で forceSelect を呼んでも preview は開かない", () => {
    setActivePinia(createPinia());
    const preview = usePreviewStore();
    const wt = useWorktreeStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.forceSelect({ kind: "worktreeRelative", relPath: "a.ts" });

    expect(wt.selection).toBeUndefined();
    expect(preview.isOpen).toBe(false);
    expect(popover.showCount).toBe(0);
  });
});

describe("usePreviewStore.toggleSummary", () => {
  test("enabled=false から → summary 有効化 + popover open", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.toggleSummary();

    expect(summary.enabled).toBe(true);
    expect(preview.isOpen).toBe(true);
    expect(popover.showCount).toBe(1);
  });

  test("enabled=true から → summary 解除 + popover close", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.toggleSummary(); // open
    preview.toggleSummary(); // close

    expect(summary.enabled).toBe(false);
    expect(preview.isOpen).toBe(false);
    expect(popover.hideCount).toBe(1);
  });

  test("file 選択経路 (summary.disable 単独) では popover を維持", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.openSummary();
    summary.disable();

    expect(summary.enabled).toBe(false);
    expect(preview.isOpen).toBe(true);
    expect(popover.hideCount).toBe(0);
  });
});

describe("usePreviewStore.close invariant", () => {
  test("close は summary も解除する (popover closed ⇒ summary disabled)", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.openSummary();
    preview.close();

    expect(summary.enabled).toBe(false);
    expect(preview.isOpen).toBe(false);
    expect(popover.hideCount).toBe(1);
  });

  test("summary 表示中の close 後に toggle で再 open しても summary view は復活しない", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.openSummary();
    preview.close();
    preview.toggle();

    expect(summary.enabled).toBe(false);
    expect(preview.isOpen).toBe(true);
  });

  test("dir 切替で popover が閉じる際 summary も同 tick で解除される", () => {
    const preview = usePreviewStore();
    const summary = useChangesSummaryStore();
    const repoStore = useRepoStore();
    const popover = createMockPopover();
    preview.bindPopover(popover.el);

    preview.openSummary();
    expect(summary.enabled).toBe(true);
    expect(preview.isOpen).toBe(true);

    repoStore.selectDir("/other-repo");

    expect(summary.enabled).toBe(false);
    expect(preview.isOpen).toBe(false);
  });
});
