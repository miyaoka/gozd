import { describe, expect, test } from "bun:test";
import { isMyWorkTruncated, myWorkCountDisplay, myWorkEmptyMessage } from "./myWorkCountDisplay";

describe("isMyWorkTruncated", () => {
  test("総件数が取得件数を上回れば切れている", () => {
    expect(
      isMyWorkTruncated({
        unreadOnly: false,
        visibleCount: 100,
        fetchedCount: 100,
        totalCount: 250,
      }),
    ).toBe(true);
  });

  test("総件数と取得件数が同じなら切れていない", () => {
    expect(
      isMyWorkTruncated({ unreadOnly: false, visibleCount: 17, fetchedCount: 17, totalCount: 17 }),
    ).toBe(false);
  });

  test("絞り込みで表示が減っても切れている判定は変わらない", () => {
    expect(
      isMyWorkTruncated({ unreadOnly: true, visibleCount: 2, fetchedCount: 17, totalCount: 17 }),
    ).toBe(false);
  });

  test("1 件も無い軸は切れていない", () => {
    expect(
      isMyWorkTruncated({ unreadOnly: false, visibleCount: 0, fetchedCount: 0, totalCount: 0 }),
    ).toBe(false);
  });
});

describe("myWorkCountDisplay", () => {
  test("絞り込み無し・切れていなければ総件数だけを出す", () => {
    const got = myWorkCountDisplay({
      unreadOnly: false,
      visibleCount: 17,
      fetchedCount: 17,
      totalCount: 17,
    });
    expect(got.label).toBe("17");
    expect(got.title).toBe("17 total");
  });

  test("切れているときは取得件数と総件数を併記する", () => {
    const got = myWorkCountDisplay({
      unreadOnly: false,
      visibleCount: 100,
      fetchedCount: 100,
      totalCount: 250,
    });
    expect(got.label).toBe("100 / 250");
    expect(got.title).toBe("Showing the 100 most recently updated of 250");
  });

  test("絞り込み中は表示件数だけを出す（切れている表記と衝突させない）", () => {
    const got = myWorkCountDisplay({
      unreadOnly: true,
      visibleCount: 2,
      fetchedCount: 17,
      totalCount: 17,
    });
    expect(got.label).toBe("2");
    expect(got.label).not.toContain("/");
    expect(got.title).toBe("2 unread of 17");
  });

  test("絞り込み中に切れていても、併記の表記は使わない", () => {
    const got = myWorkCountDisplay({
      unreadOnly: true,
      visibleCount: 28,
      fetchedCount: 100,
      totalCount: 250,
    });
    expect(got.label).toBe("28");
    expect(got.label).not.toContain("/");
    // 切れている事実は説明のほうが運ぶ
    expect(got.title).toBe("28 unread among the 100 most recently updated of 250");
  });

  test("絞り込みで 0 件になっても総件数は残る", () => {
    const got = myWorkCountDisplay({
      unreadOnly: true,
      visibleCount: 0,
      fetchedCount: 17,
      totalCount: 17,
    });
    expect(got.label).toBe("0");
    expect(got.title).toBe("0 unread of 17");
  });

  test("軸そのものが空なら 0 を出す", () => {
    const got = myWorkCountDisplay({
      unreadOnly: false,
      visibleCount: 0,
      fetchedCount: 0,
      totalCount: 0,
    });
    expect(got.label).toBe("0");
    expect(got.title).toBe("0 total");
  });
});

describe("myWorkEmptyMessage", () => {
  test("絞り込み中の空は未読が無いことを示す", () => {
    expect(myWorkEmptyMessage(true)).toBe("No unread items");
  });

  test("絞り込み無しの空は軸に何も無いことを示す", () => {
    expect(myWorkEmptyMessage(false)).toBe("Nothing here");
  });
});
