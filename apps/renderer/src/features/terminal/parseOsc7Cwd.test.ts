import { describe, expect, test } from "bun:test";
import { parseOsc7Cwd } from "./parseOsc7Cwd";

describe("parseOsc7Cwd", () => {
  test("ホスト名付き file URI からパスを抽出する", () => {
    expect(parseOsc7Cwd("file://mac.local/Users/foo/repo")).toBe("/Users/foo/repo");
  });

  test("ホスト名なし（file:///path）からパスを抽出する", () => {
    expect(parseOsc7Cwd("file:///Users/foo/repo")).toBe("/Users/foo/repo");
  });

  test("percent-encode されたパスを decode する", () => {
    expect(parseOsc7Cwd("file://host/Users/foo/%E4%BD%9C%E6%A5%AD")).toBe("/Users/foo/作業");
  });

  test("decode 失敗（生パスに % + 非 hex）は生文字列に倒す", () => {
    expect(parseOsc7Cwd("file://host/Users/foo/100%done")).toBe("/Users/foo/100%done");
  });

  test("file スキーム以外は undefined", () => {
    expect(parseOsc7Cwd("https://example.com/path")).toBeUndefined();
  });

  test("パス部がない（ホストのみ）は undefined", () => {
    expect(parseOsc7Cwd("file://hostonly")).toBeUndefined();
  });
});
