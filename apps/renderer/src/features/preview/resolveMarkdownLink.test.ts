import { describe, expect, test } from "bun:test";
import { resolveMarkdownLink } from "./resolveMarkdownLink";

/**
 * `relDirOf` / `normalizePath` の挙動は別ファイル (filer/relDirOf.test.ts, worktree/pathUtils.test.ts) で
 * SSOT としてテストされている。ここでは `resolveMarkdownLink` 自体のロジックを切り分けるため
 * 同等仕様の小さな fake を inline で渡す。
 */
function fakeRelDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.substring(0, idx);
}

function fakeNormalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const segments = path.split("/").filter((s) => s !== "");
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbsolute) {
        result.push("..");
      }
      continue;
    }
    result.push(seg);
  }
  const joined = result.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

function resolve(href: string, basePath: string | undefined) {
  return resolveMarkdownLink({
    href,
    basePath,
    relDirOf: fakeRelDirOf,
    normalizePath: fakeNormalizePath,
  });
}

describe("resolveMarkdownLink", () => {
  describe("passthrough", () => {
    test("http(s) URL は passthrough", () => {
      expect(resolve("https://example.com/", "docs/preview.md")).toEqual({ kind: "passthrough" });
      expect(resolve("http://example.com/", "docs/preview.md")).toEqual({ kind: "passthrough" });
    });

    test("mailto: は passthrough", () => {
      expect(resolve("mailto:user@example.com", "docs/preview.md")).toEqual({
        kind: "passthrough",
      });
    });

    test("scheme 付き URL (gozd-rpc://, vscode:// 等) は passthrough", () => {
      expect(resolve("gozd-rpc://localhost/", "docs/preview.md")).toEqual({ kind: "passthrough" });
      expect(resolve("vscode://", "docs/preview.md")).toEqual({ kind: "passthrough" });
    });

    test("# 単独は passthrough (同一文書内アンカー)", () => {
      expect(resolve("#section", "docs/preview.md")).toEqual({ kind: "passthrough" });
      expect(resolve("#", "docs/preview.md")).toEqual({ kind: "passthrough" });
    });
  });

  describe("internal", () => {
    test("./ 相対パスを selectedPath の dir 基準で解決する", () => {
      expect(resolve("./workspace.md", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/workspace.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("../ で親ディレクトリに上がる", () => {
      expect(resolve("../CLAUDE.md", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "CLAUDE.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("名前のみのリンクは selectedPath の dir 基準で解決", () => {
      expect(resolve("rpc.md", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/rpc.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("/ 始まりは worktree ルート相対", () => {
      expect(resolve("/CLAUDE.md", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "CLAUDE.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("root file から ./other.md は worktree root 基準で結合", () => {
      expect(resolve("./other.md", "README.md")).toEqual({
        kind: "internal",
        path: "other.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("URL エンコードされたファイル名 (%20) を decode する", () => {
      expect(resolve("./foo%20bar.md", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo bar.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("query string は path 部から落とす", () => {
      expect(resolve("./foo.md?v=1", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("basePath が undefined のときは worktree root 基準", () => {
      expect(resolve("./README.md", undefined)).toEqual({
        kind: "internal",
        path: "README.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });
  });

  describe("line fragment", () => {
    test("#L42 を lineNumber として抽出", () => {
      expect(resolve("./foo.ts#L42", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.ts",
        lineNumber: 42,
        droppedAnchor: false,
      });
    });

    test("#42 (L 無し) も lineNumber として抽出", () => {
      expect(resolve("./foo.ts#42", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.ts",
        lineNumber: 42,
        droppedAnchor: false,
      });
    });

    test("#L42,5 (列付き) は startLine だけ抽出", () => {
      expect(resolve("./foo.ts#L42,5", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.ts",
        lineNumber: 42,
        droppedAnchor: false,
      });
    });

    test("#L42-L50 (範囲) は startLine だけ抽出", () => {
      expect(resolve("./foo.ts#L42-L50", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.ts",
        lineNumber: 42,
        droppedAnchor: false,
      });
    });

    test("#section など行番号でない anchor は droppedAnchor: true", () => {
      expect(resolve("./foo.md#installation", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.md",
        lineNumber: undefined,
        droppedAnchor: true,
      });
    });

    test("#L0 は無効として droppedAnchor: true", () => {
      expect(resolve("./foo.ts#L0", "docs/preview.md")).toEqual({
        kind: "internal",
        path: "docs/foo.ts",
        lineNumber: undefined,
        droppedAnchor: true,
      });
    });
  });

  describe("invalid", () => {
    test("空文字は invalid", () => {
      expect(resolve("", "docs/preview.md")).toEqual({
        kind: "invalid",
        reason: "Empty link target",
      });
    });

    test("?query 単独は invalid", () => {
      const result = resolve("?v=1", "docs/preview.md");
      expect(result.kind).toBe("invalid");
    });

    test("空白のみは invalid", () => {
      const result = resolve("   ", "docs/preview.md");
      expect(result.kind).toBe("invalid");
    });

    test("不正な URL エンコーディング (%ZZ) は invalid", () => {
      const result = resolve("./foo%ZZ.md", "docs/preview.md");
      expect(result.kind).toBe("invalid");
    });

    test("worktree 外を指す ../ は invalid", () => {
      const result = resolve("../../etc/passwd", "README.md");
      expect(result.kind).toBe("invalid");
    });

    test("深いネスト経由でも worktree 外は invalid", () => {
      const result = resolve("../../../etc/passwd", "docs/preview.md");
      expect(result.kind).toBe("invalid");
    });
  });
});
