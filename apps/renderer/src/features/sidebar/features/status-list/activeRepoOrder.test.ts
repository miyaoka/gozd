import { describe, expect, test } from "bun:test";
import { nextActiveRepoOrder } from "./activeRepoOrder";

describe("nextActiveRepoOrder", () => {
  test("新しく現れた repo は先頭に足し、残っている repo の順は変えない", () => {
    expect(nextActiveRepoOrder(["/a", "/b"], ["/b", "/c", "/a"])).toEqual(["/c", "/a", "/b"]);
  });

  test("消えた repo は落とし、再び現れたら先頭に付く", () => {
    const withoutA = nextActiveRepoOrder(["/a", "/b"], ["/b"]);
    expect(withoutA).toEqual(["/b"]);
    expect(nextActiveRepoOrder(withoutA, ["/a", "/b"])).toEqual(["/a", "/b"]);
  });

  test("同じ repo の複数セッションは 1 つに数える", () => {
    expect(nextActiveRepoOrder([], ["/a", "/a", "/b"])).toEqual(["/a", "/b"]);
  });

  test("顔ぶれが変わらなければ prev をそのまま返す", () => {
    const prev = ["/a", "/b"];
    expect(nextActiveRepoOrder(prev, ["/b", "/a", "/a"])).toBe(prev);
  });
});
