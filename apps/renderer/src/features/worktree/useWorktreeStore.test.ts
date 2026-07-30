import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../shared/repo";
import { useWorktreeStore } from "./useWorktreeStore";

/**
 * ツリー reveal 要求と selection の分離を検証する。
 *
 * reveal は「発火が要求 object の identity に依存する」「selection を動かす経路と動かさない経路が
 * 併存する」という 2 点が実装から読み取りにくく、片方だけ壊れても型・lint では落ちない。
 */
const DIR = "/repo";
const OTHER_DIR = "/other-repo";

beforeEach(() => {
  setActivePinia(createPinia());
  useRepoStore().selectDir(DIR);
});

describe("useWorktreeStore の reveal 要求", () => {
  test("selectRelPath は selection と reveal 要求の両方を出す", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    expect(wt.selectedRelPath).toBe("src/a.ts");
    expect(wt.revealRequest?.relPath).toBe("src/a.ts");
  });

  test("同一パスの再要求でも新しい object になる（購読側は identity で発火する）", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    const first = wt.revealRequest;
    wt.selectRelPath("src/a.ts");
    expect(wt.revealRequest).not.toBe(first);
    expect(wt.revealRequest?.relPath).toBe("src/a.ts");
    expect(wt.revealRequest?.seq).toBeGreaterThan(first?.seq ?? 0);
  });

  test("正規化前の綴りでも selection と reveal 対象が揃う", () => {
    // terminal のファイルパスリンクは matched token をそのまま渡すため `./` 付きが入る。
    // 片方だけ正規化すると reveal 対象がツリーの path と一致せず、reveal だけ無音で落ちる
    const wt = useWorktreeStore();
    wt.selectRelPath("./src/a.ts");
    expect(wt.selectedRelPath).toBe("src/a.ts");
    expect(wt.revealRequest?.relPath).toBe("src/a.ts");
  });

  test("revealRelPath は selection を動かさずツリーだけ移動させる", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    wt.revealRelPath("docs");
    expect(wt.revealRequest?.relPath).toBe("docs");
    // selection が dir に動くと preview がディレクトリ表示に落ちるため、動かさないことが契約
    expect(wt.selectedRelPath).toBe("src/a.ts");
  });

  test("selectAbsPath は reveal 要求を落とす（worktree 外はツリーに対応ノードが無い）", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    wt.selectAbsPath("/elsewhere/b.ts");
    expect(wt.revealRequest).toBeUndefined();
    expect(wt.selectedRelPath).toBeUndefined();
  });

  test("clearSelectedPath は reveal 要求も落とす", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    wt.clearSelectedPath();
    expect(wt.revealRequest).toBeUndefined();
    expect(wt.selection).toBeUndefined();
  });

  test("dir 切替は selection と reveal 要求を落とす", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    useRepoStore().selectDir(OTHER_DIR);
    expect(wt.revealRequest).toBeUndefined();
    expect(wt.selection).toBeUndefined();
  });

  test("selectPathVersion は select*Path でだけ進み、tree reveal では進まない", () => {
    const wt = useWorktreeStore();
    wt.selectRelPath("src/a.ts");
    const afterSelect = wt.selectPathVersion;
    wt.revealRelPath("docs");
    expect(wt.selectPathVersion).toBe(afterSelect);
    wt.selectRelPath("src/b.ts");
    expect(wt.selectPathVersion).toBeGreaterThan(afterSelect);
  });
});
