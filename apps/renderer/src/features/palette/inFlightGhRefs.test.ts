import { ghRefForIssue, ghRefForPr } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { inFlightKey } from "./inFlightGhRefs";

describe("inFlightKey", () => {
  test("同一入力は同一キーになる (picker 開き直し後の item も同じキーで排他される)", () => {
    expect(inFlightKey("/repo", ghRefForPr(42))).toBe(inFlightKey("/repo", ghRefForPr(42)));
  });

  // GitHub の番号空間は repo 単位。別 repo の同番号を誤ブロックしないことが契約
  test("repo が違えば同番号でもキーが衝突しない", () => {
    expect(inFlightKey("/repo-a", ghRefForIssue(1))).not.toBe(
      inFlightKey("/repo-b", ghRefForIssue(1)),
    );
  });

  test("同番号でも PR と issue はキーが衝突しない", () => {
    expect(inFlightKey("/repo", ghRefForPr(7))).not.toBe(inFlightKey("/repo", ghRefForIssue(7)));
  });
});
