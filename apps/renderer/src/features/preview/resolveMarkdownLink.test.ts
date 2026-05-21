import { describe, expect, test } from "bun:test";
import { resolveMarkdownLink } from "./resolveMarkdownLink";

/**
 * `relDirOf` / `normalizePath` の挙動は別ファイル
 * (`filer/relDirOf.test.ts`, `worktree/pathUtils.test.ts`) で SSOT としてテスト済み。
 *
 * 本来は barrel 経由 (`../filer` / `../worktree`) で本物を import して挙動差を消したいが、
 * worktree barrel は `useWorktreeStore` 等のロードで `window.__gozdReceive` を参照する
 * shared/rpc モジュールを芋づる式に取り込むため bun:test 環境で失敗する。
 * barrel-import ルールにより別 feature の内部モジュール (`../filer/relDirOf`) を直接
 * import することも禁止されている。
 *
 * 折衷案として `pathUtils.ts:normalizePath` / `relDirOf.ts` のロジックを inline fake で
 * 完全に写し取る (tilde 分岐含む)。本物との挙動差が出ないことは仕様の一致で担保する。
 */
function fakeRelDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.substring(0, idx);
}

function fakeNormalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const isTilde = path.startsWith("~/");

  const segments = path.split("/").filter((s) => s !== "");
  const result: string[] = [];

  const startIdx = isTilde ? 1 : 0;

  for (let i = startIdx; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbsolute && !isTilde) {
        result.push("..");
      }
      continue;
    }
    result.push(seg);
  }

  const joined = result.join("/");
  if (isTilde) return `~/${joined}`;
  if (isAbsolute) return `/${joined}`;
  return joined;
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
  describe("passthrough (allowlist のみ)", () => {
    test("http(s) URL は passthrough", () => {
      expect(resolve("https://example.com/", "docs/preview.md")).toEqual({ kind: "passthrough" });
      expect(resolve("http://example.com/", "docs/preview.md")).toEqual({ kind: "passthrough" });
    });

    test("mailto: は passthrough", () => {
      expect(resolve("mailto:user@example.com", "docs/preview.md")).toEqual({
        kind: "passthrough",
      });
    });

    test("# 単独は passthrough (同一文書内アンカー)", () => {
      expect(resolve("#section", "docs/preview.md")).toEqual({ kind: "passthrough" });
      expect(resolve("#", "docs/preview.md")).toEqual({ kind: "passthrough" });
    });

    test("scheme 大文字小文字混在も passthrough", () => {
      expect(resolve("HTTPS://example.com/", "docs/preview.md")).toEqual({ kind: "passthrough" });
      expect(resolve("Mailto:user@example.com", "docs/preview.md")).toEqual({
        kind: "passthrough",
      });
    });
  });

  describe("scheme allowlist 外 (invalid)", () => {
    test("gozd-rpc:// は invalid (RPC 経路への遷移を許可しない)", () => {
      const result = resolve("gozd-rpc://localhost/fs/readFile", "docs/preview.md");
      expect(result.kind).toBe("invalid");
    });

    test("gozd-app:// は invalid (内部 asset scheme)", () => {
      const result = resolve("gozd-app://localhost/views/main/", "docs/preview.md");
      expect(result.kind).toBe("invalid");
    });

    test("file:, data:, javascript: は invalid", () => {
      expect(resolve("file:///etc/passwd", "docs/preview.md").kind).toBe("invalid");
      expect(resolve("data:text/html,<h1>x</h1>", "docs/preview.md").kind).toBe("invalid");
      expect(resolve("javascript:alert(1)", "docs/preview.md").kind).toBe("invalid");
    });

    test("vscode:// 等の未許可 scheme は invalid", () => {
      expect(resolve("vscode://file/Users/foo", "docs/preview.md").kind).toBe("invalid");
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

    test("`..` で始まる正当なファイル名は internal (worktree 外と誤検出しない)", () => {
      // root file 起点で `..hidden.md` を参照 → normalize 後も `..hidden.md`。
      // `..` 単独ではなく、`../` でも始まらないため worktree 内とみなす。
      expect(resolve("./..hidden.md", "README.md")).toEqual({
        kind: "internal",
        path: "..hidden.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("`..` 始まりのディレクトリ名も internal", () => {
      expect(resolve("./..bak/foo.md", "README.md")).toEqual({
        kind: "internal",
        path: "..bak/foo.md",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("`~` 始まりの正当なファイル名は internal", () => {
      expect(resolve("./~tmp.md", "README.md")).toEqual({
        kind: "internal",
        path: "~tmp.md",
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
      expect(resolve("?v=1", "docs/preview.md").kind).toBe("invalid");
    });

    test("空白のみは invalid", () => {
      expect(resolve("   ", "docs/preview.md").kind).toBe("invalid");
    });

    test("不正な URL エンコーディング (%ZZ) は invalid", () => {
      expect(resolve("./foo%ZZ.md", "docs/preview.md").kind).toBe("invalid");
    });

    test("worktree 外を指す ../ は invalid", () => {
      expect(resolve("../../etc/passwd", "README.md").kind).toBe("invalid");
    });

    test("深いネスト経由でも worktree 外は invalid", () => {
      expect(resolve("../../../etc/passwd", "docs/preview.md").kind).toBe("invalid");
    });
  });

  describe("absolute basePath (worktree 外 markdown を terminal link から開いた経路)", () => {
    test("相対リンクは絶対 basePath dir 内に絶対パスとして解決する", () => {
      expect(resolve("./image.png", "/Users/me/elsewhere/README.md")).toEqual({
        kind: "internal",
        path: "/Users/me/elsewhere/image.png",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("子ディレクトリへの相対リンクは internal", () => {
      expect(resolve("./images/x.png", "/Users/me/elsewhere/README.md")).toEqual({
        kind: "internal",
        path: "/Users/me/elsewhere/images/x.png",
        lineNumber: undefined,
        droppedAnchor: false,
      });
    });

    test("`../` で basePath dir を抜けるリンクは invalid (信頼境界縮小)", () => {
      // basePath dir `/Users/me/elsewhere/docs` を抜ける `../sibling.md` は invalid。
      // 同じドキュメントツリー扱いせず、絶対 basePath では「source file の dir 配下のみ」を信頼境界とする。
      expect(resolve("../sibling.md", "/Users/me/elsewhere/docs/README.md").kind).toBe("invalid");
    });

    test("行番号 fragment も absolute base 経路で抽出される", () => {
      expect(resolve("./foo.ts#L42", "/Users/me/elsewhere/README.md")).toEqual({
        kind: "internal",
        path: "/Users/me/elsewhere/foo.ts",
        lineNumber: 42,
        droppedAnchor: false,
      });
    });

    test("`/` 始まりの絶対パスは basePath dir 配下でない限り invalid (path traversal block)", () => {
      // basePath dir = `/Users/me/elsewhere`。/Users/me/other/foo.md は配下でないため invalid
      expect(resolve("/Users/me/other/foo.md", "/Users/me/elsewhere/README.md").kind).toBe(
        "invalid",
      );
    });

    test("`/etc/passwd` 系の絶対パスは basePath dir を抜けるため invalid", () => {
      expect(resolve("/etc/passwd", "/Users/me/elsewhere/README.md").kind).toBe("invalid");
    });

    test("`../../etc/passwd` 系の相対 traversal も basePath dir を抜けると invalid", () => {
      expect(resolve("../../etc/passwd", "/Users/me/elsewhere/README.md").kind).toBe("invalid");
    });

    test("basePath dir そのもの (末尾 `/`) を指すリンクは invalid (ディレクトリ参照)", () => {
      // ./ → normalize で /Users/me/elsewhere に解決 → basePath dir 自身は配下とみなさず invalid
      expect(resolve("./", "/Users/me/elsewhere/README.md").kind).toBe("invalid");
    });
  });
});
