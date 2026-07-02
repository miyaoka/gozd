import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../../../shared/repo";
import { useWorktreeStore } from "../../../worktree";
import { useMarkdownHistoryStore } from "./useMarkdownHistoryStore";

/**
 * useMarkdownHistoryStore は worktreeStore.selection に対する flush:sync watch を持つので、
 * テストでは pinia を毎回 fresh に作り、`repoStore.selectDir` で dir を確立してから
 * worktreeStore.selectRelPath を呼んで selection を動かす。
 */
const DIR = "/repo";

beforeEach(() => {
  setActivePinia(createPinia());
  const repoStore = useRepoStore();
  repoStore.selectDir(DIR);
});

describe("useMarkdownHistoryStore", () => {
  test("初期状態は back / forward ともに不可", () => {
    const history = useMarkdownHistoryStore();
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
  });

  test("navigate で back に積まれ forward は空のまま", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");
    // 上の select は外部経路なので履歴は clear される (= 初期と同じ状態に保たれる)
    expect(history.canGoBack).toBe(false);

    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    expect(wt.selectedRelPath).toBe("b.md");
    expect(history.canGoBack).toBe(true);
    expect(history.canGoForward).toBe(false);
  });

  test("goBack で前の selection に戻り forward が増える", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });

    history.goBack();
    expect(wt.selectedRelPath).toBe("a.md");
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(true);
  });

  test("goForward で戻した selection を再度進める", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    history.goBack();

    history.goForward();
    expect(wt.selectedRelPath).toBe("b.md");
    expect(history.canGoBack).toBe(true);
    expect(history.canGoForward).toBe(false);
  });

  test("3 段の back を経て back → forward を往復してもスタックが対称的に推移する", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    history.navigate({ kind: "worktreeRelative", relPath: "c.md" });

    history.goBack();
    expect(wt.selectedRelPath).toBe("b.md");
    history.goBack();
    expect(wt.selectedRelPath).toBe("a.md");
    expect(history.canGoBack).toBe(false);

    history.goForward();
    expect(wt.selectedRelPath).toBe("b.md");
    history.goForward();
    expect(wt.selectedRelPath).toBe("c.md");
    expect(history.canGoForward).toBe(false);
  });

  test("空 stack に対する goBack / goForward は no-op", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");

    history.goBack();
    expect(wt.selectedRelPath).toBe("a.md");
    history.goForward();
    expect(wt.selectedRelPath).toBe("a.md");
  });

  test("外部経路 (worktreeStore.selectRelPath 直接) で selection が変わると履歴 clear", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    expect(history.canGoBack).toBe(true);

    wt.selectRelPath("c.md"); // 外部経路 = 履歴破棄
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
  });

  test("同パス・同 lineNumber への再 navigate は履歴に積まない (自己リンク・往復による back 汚染防止)", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");

    // 自己リンククリック (a.md の中の [a.md])
    history.navigate({ kind: "worktreeRelative", relPath: "a.md" });
    expect(history.canGoBack).toBe(false);

    // 別ファイル → 自己リンク往復で back スタックが汚染されないか
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    // back には a.md だけが居て、b.md → b.md の重複は積まれない
    expect(history.canGoBack).toBe(true);
    history.goBack();
    expect(wt.selectedRelPath).toBe("a.md");
    expect(history.canGoBack).toBe(false);
  });

  test("lineNumber が違えば同パスでも navigate として扱う", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md", 10);

    history.navigate({ kind: "worktreeRelative", relPath: "a.md" }, 42);
    expect(history.canGoBack).toBe(true);
    history.goBack();
    expect(wt.selectedRelPath).toBe("a.md");
    expect(wt.selectedLineNumber).toBe(10);
  });

  test("dir 切替 (worktreeStore.selection が undefined に倒される) で履歴 clear", () => {
    const wt = useWorktreeStore();
    const repoStore = useRepoStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");
    history.navigate({ kind: "worktreeRelative", relPath: "b.md" });
    expect(history.canGoBack).toBe(true);

    repoStore.selectDir("/other-repo");
    // worktreeStore の dir watch (sync) が selection を undefined に倒し、
    // markdownHistory の watch が外部経路として両 stack を clear する。
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
  });

  test("kind が違うと別 selection 扱い", () => {
    const wt = useWorktreeStore();
    const history = useMarkdownHistoryStore();
    wt.selectRelPath("a.md");

    history.navigate({ kind: "absolute", absPath: "/external/a.md" });
    expect(history.canGoBack).toBe(true);
    history.goBack();
    expect(wt.selection?.kind).toBe("worktreeRelative");
  });
});
