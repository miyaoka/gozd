import { describe, expect, test } from "bun:test";
import { expandFilterGlobs } from "./expandFilterGlobs";

describe("expandFilterGlobs", () => {
  test("空文字は空配列", () => {
    expect(expandFilterGlobs("")).toEqual([]);
    expect(expandFilterGlobs("  ,  ")).toEqual([]);
  });

  test("各パターンを [配下用, エントリ自体用] の 2 形に展開する（VS Code expandGlobalGlob）", () => {
    // どちらも ** 始まりなので getRgArgs の doubleStar 分岐に入り nested でも descent できる
    expect(expandFilterGlobs("studio-app")).toEqual(["**/studio-app/**", "**/studio-app"]);
  });

  test("カンマ区切りは各要素を展開して連結", () => {
    expect(expandFilterGlobs("a, b")).toEqual(["**/a/**", "**/a", "**/b/**", "**/b"]);
  });

  test("末尾スラッシュのディレクトリはスラッシュを除いて展開", () => {
    expect(expandFilterGlobs("src/")).toEqual(["**/src/**", "**/src"]);
  });

  test("先頭ドットの拡張子指定は * を前置（.ts → *.ts）", () => {
    expect(expandFilterGlobs(".ts")).toEqual(["**/*.ts/**", "**/*.ts"]);
  });

  test("glob を含むパターンも同じ 2 形展開（*.ts は全階層に効く **/*.ts を生む）", () => {
    expect(expandFilterGlobs("*.ts")).toEqual(["**/*.ts/**", "**/*.ts"]);
  });
});
