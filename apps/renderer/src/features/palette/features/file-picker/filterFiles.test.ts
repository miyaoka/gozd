import { describe, expect, test } from "bun:test";
import { FILE_PICKER_MAX_RESULTS, filterFiles } from "./filterFiles";

describe("filterFiles", () => {
  test("空クエリは先頭 limit 件をそのまま返す", () => {
    const files = Array.from({ length: FILE_PICKER_MAX_RESULTS + 50 }, (_, i) => `f${i}.ts`);
    const result = filterFiles(files, "");
    expect(result.length).toBe(FILE_PICKER_MAX_RESULTS);
    expect(result[0]).toBe("f0.ts");
  });

  test("マッチしないパスを除外する", () => {
    expect(filterFiles(["src/foo.ts", "src/bar.ts"], "foo")).toEqual(["src/foo.ts"]);
  });

  test("サブシーケンスでマッチする", () => {
    expect(filterFiles(["src/useFilePicker.ts"], "ufp")).toEqual(["src/useFilePicker.ts"]);
  });

  test("ファイル名境界の一致がディレクトリ途中の一致よりも上位になる", () => {
    const files = ["src/information/deep.ts", "src/info.ts"];
    expect(filterFiles(files, "info")[0]).toBe("src/info.ts");
  });

  test("マッチ件数が limit を超えたら打ち切る", () => {
    const files = Array.from({ length: FILE_PICKER_MAX_RESULTS + 10 }, (_, i) => `src/a${i}.ts`);
    expect(filterFiles(files, "a").length).toBe(FILE_PICKER_MAX_RESULTS);
  });

  test("同点スコアは短いパスを優先する", () => {
    const files = ["src/deeper/dir/same.ts", "src/a/same.ts"];
    expect(filterFiles(files, "same")).toEqual(["src/a/same.ts", "src/deeper/dir/same.ts"]);
  });

  test("同点スコア・同長は入力順を保つ", () => {
    const files = ["src/b/same.ts", "src/a/same.ts"];
    expect(filterFiles(files, "same")).toEqual(["src/b/same.ts", "src/a/same.ts"]);
  });
});
