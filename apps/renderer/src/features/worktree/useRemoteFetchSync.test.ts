import { describe, expect, test } from "bun:test";
import { computeFetchTargets } from "./useRemoteFetchSync";

const sorted = (set: Set<string>) => [...set].sort();

describe("computeFetchTargets", () => {
  test("空集合 + active 未設定は空", () => {
    expect(computeFetchTargets([], undefined).size).toBe(0);
  });

  test("画面に写っている repo だけを対象にする", () => {
    expect(sorted(computeFetchTargets(["/a", "/b"], undefined))).toEqual(["/a", "/b"]);
  });

  // active repo は畳まれ / スクロール外 (= onScreen に居ない) でも union に加わる
  test("active repo は onScreen に無くても union に加わる", () => {
    expect(sorted(computeFetchTargets([], "/active"))).toEqual(["/active"]);
    expect(sorted(computeFetchTargets(["/a"], "/active"))).toEqual(["/a", "/active"]);
  });

  // active repo が既に onScreen に含まれるなら Set が重複を畳む
  test("active repo が onScreen に含まれても重複しない", () => {
    expect(sorted(computeFetchTargets(["/a", "/active"], "/active"))).toEqual(["/a", "/active"]);
  });
});
