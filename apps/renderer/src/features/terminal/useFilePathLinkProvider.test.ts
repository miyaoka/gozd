import { describe, expect, test } from "bun:test";
import { findRelativePaths } from "./findRelativePaths";

describe("findRelativePaths", () => {
  test("基本的な相対パスを検出する", () => {
    const results = findRelativePaths("src/main.ts");
    expect(results).toEqual([{ path: "src/main.ts", startIdx: 0, endIdx: 11 }]);
  });

  test("深いパスを検出する", () => {
    const [result] = findRelativePaths("apps/renderer/src/features/filer/filerUtils.ts");
    expect(result?.path).toBe("apps/renderer/src/features/filer/filerUtils.ts");
  });

  test("複数ドットの拡張子を検出する（.test.ts）", () => {
    const [result] = findRelativePaths("src/features/filer/filerUtils.test.ts");
    expect(result?.path).toBe("src/features/filer/filerUtils.test.ts");
  });

  test(".spec.tsx を検出する", () => {
    const [result] = findRelativePaths("src/App.spec.tsx");
    expect(result?.path).toBe("src/App.spec.tsx");
  });

  test(".d.ts を検出する", () => {
    const [result] = findRelativePaths("src/types/env.d.ts");
    expect(result?.path).toBe("src/types/env.d.ts");
  });

  test("@ プレフィックスのパスを検出する", () => {
    const [result] = findRelativePaths("@gozd/shared/result.ts");
    expect(result?.path).toBe("@gozd/shared/result.ts");
  });

  test("テキスト中の複数パスを検出する", () => {
    const results = findRelativePaths("modified: src/a.ts and src/b.vue");
    expect(results.map((r) => r.path)).toEqual(["src/a.ts", "src/b.vue"]);
  });

  test("拡張子なしのパスは検出しない", () => {
    expect(findRelativePaths("src/features/filer")).toEqual([]);
  });

  test("単一セグメントのファイルは検出しない", () => {
    expect(findRelativePaths("main.ts")).toEqual([]);
  });

  test("行番号付きパスを検出する", () => {
    const results = findRelativePaths("src/main.ts:30");
    expect(results).toEqual([{ path: "src/main.ts", startIdx: 0, endIdx: 14, lineNumber: 30 }]);
  });

  test("行番号なしのパスには lineNumber が含まれない", () => {
    const [result] = findRelativePaths("src/main.ts");
    expect(result?.lineNumber).toBeUndefined();
  });

  test("テキスト中の行番号付きパスを検出する", () => {
    const results = findRelativePaths("error at src/app.vue:25 and src/main.ts:100");
    expect(results).toEqual([
      { path: "src/app.vue", startIdx: 9, endIdx: 23, lineNumber: 25 },
      { path: "src/main.ts", startIdx: 28, endIdx: 43, lineNumber: 100 },
    ]);
  });
});
