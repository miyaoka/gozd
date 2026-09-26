import { describe, expect, test } from "bun:test";
import { inFlightKey } from "./inFlightItems";

describe("inFlightKey", () => {
  test("同一入力は同一キーになる (picker 開き直し後の item も同じキーで排他される)", () => {
    expect(inFlightKey("/repo", "pr", 42)).toBe(inFlightKey("/repo", "pr", 42));
  });

  // GitHub の番号空間は repo 単位。別 repo の同番号を誤ブロックしないことが契約
  test("repo が違えば同番号でもキーが衝突しない", () => {
    expect(inFlightKey("/repo-a", "issue", 1)).not.toBe(inFlightKey("/repo-b", "issue", 1));
  });

  test("同番号でも PR と issue はキーが衝突しない", () => {
    expect(inFlightKey("/repo", "pr", 7)).not.toBe(inFlightKey("/repo", "issue", 7));
  });
});
