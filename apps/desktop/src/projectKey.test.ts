import { describe, expect, test } from "bun:test";
import { projectKey, truncateToBytes } from "./projectKey";

describe("truncateToBytes", () => {
  test("ASCII 文字列が上限以内ならそのまま返す", () => {
    expect(truncateToBytes("hello", 10)).toBe("hello");
  });

  test("ASCII 文字列が上限を超えたら切り詰める", () => {
    expect(truncateToBytes("hello", 3)).toBe("hel");
  });

  test("マルチバイト文字の途中で切れない", () => {
    // "あ" は UTF-8 で 3 bytes
    // maxBytes=5 だと "あ"(3) + "い"(3) = 6 で超えるため "あ" のみ
    expect(truncateToBytes("あいう", 5)).toBe("あ");
  });

  test("マルチバイト文字がちょうど収まる", () => {
    // "あ"(3) + "い"(3) = 6 bytes
    expect(truncateToBytes("あいう", 6)).toBe("あい");
  });

  test("絵文字（4 bytes）の途中で切れない", () => {
    // "🎉" は UTF-8 で 4 bytes
    // maxBytes=3 だと収まらないので空文字列
    expect(truncateToBytes("🎉test", 3)).toBe("");
  });

  test("絵文字がちょうど収まる", () => {
    expect(truncateToBytes("🎉test", 4)).toBe("🎉");
  });

  test("絵文字混在で正しく切り詰める", () => {
    // "a"(1) + "🎉"(4) + "b"(1) = 6 bytes
    expect(truncateToBytes("a🎉b", 5)).toBe("a🎉");
    expect(truncateToBytes("a🎉b", 6)).toBe("a🎉b");
  });

  test("空文字列はそのまま返す", () => {
    expect(truncateToBytes("", 10)).toBe("");
  });
});

describe("projectKey", () => {
  test("存在するディレクトリに対して <name>-<hash12> 形式を返す", () => {
    const key = projectKey("/tmp");
    expect(key).toMatch(/^[^-]+-[0-9a-f]{12}$/);
  });

  test("同じパスに対して同じキーを返す", () => {
    expect(projectKey("/tmp")).toBe(projectKey("/tmp"));
  });

  test("結果が NAME_MAX（255 bytes）以内に収まる", () => {
    const key = projectKey("/tmp");
    expect(Buffer.byteLength(key, "utf-8")).toBeLessThanOrEqual(255);
  });
});
