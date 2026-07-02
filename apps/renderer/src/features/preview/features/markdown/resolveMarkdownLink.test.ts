import { describe, expect, test } from "bun:test";
import { normalizeAbsolute, normalizeRelative, type PathTarget } from "../../../worktree";
import { resolveMarkdownLink } from "./resolveMarkdownLink";

/**
 * 本物の `normalizeRelative` / `normalizeAbsolute` を inject する。
 * fake で複写しないことで本物との挙動差バグを構造的に防ぐ。
 *
 * **`relDirOf` だけは local 複写**: `filer` barrel が `useFileIcon.ts` 経由で
 * `import.meta.glob` (Vite 専用 API) をモジュールトップで呼ぶため bun:test がロード失敗する。
 * これは本 PR スコープ外の filer feature 側の構造問題で、解消には `import.meta.glob` を
 * 遅延化する別 refactor が必要。当面は trivial な 2 行関数として local 複写し、
 * 本物 (`filer/relDirOf.ts`) との挙動差は `relDirOf.test.ts` 側で担保する。
 */
function relDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.substring(0, idx);
}

/** worktree 相対 basePath の factory (test の sniff を撲滅する) */
function relBase(relPath: string): PathTarget {
  return { kind: "worktreeRelative", relPath };
}

/** worktree 外絶対 basePath の factory */
function absBase(absPath: string): PathTarget {
  return { kind: "absolute", absPath };
}

function resolve(href: string, basePath: PathTarget | undefined) {
  return resolveMarkdownLink({
    href,
    basePath,
    relDirOf,
    normalizeRelative,
    normalizeAbsolute,
  });
}

function expectInternalRel(
  href: string,
  basePath: PathTarget | undefined,
  expected: {
    relPath: string;
    lineNumber?: number;
    droppedAnchor?: boolean;
  },
) {
  expect(resolve(href, basePath)).toEqual({
    kind: "internal",
    selection: { kind: "worktreeRelative", relPath: expected.relPath },
    lineNumber: expected.lineNumber,
    droppedAnchor: expected.droppedAnchor ?? false,
  });
}

function expectInternalAbs(
  href: string,
  basePath: PathTarget | undefined,
  expected: {
    absPath: string;
    lineNumber?: number;
    droppedAnchor?: boolean;
  },
) {
  expect(resolve(href, basePath)).toEqual({
    kind: "internal",
    selection: { kind: "absolute", absPath: expected.absPath },
    lineNumber: expected.lineNumber,
    droppedAnchor: expected.droppedAnchor ?? false,
  });
}

describe("resolveMarkdownLink", () => {
  describe("passthrough (allowlist のみ)", () => {
    test("http(s) URL は passthrough", () => {
      expect(resolve("https://example.com/", relBase("docs/preview.md"))).toEqual({
        kind: "passthrough",
      });
      expect(resolve("http://example.com/", relBase("docs/preview.md"))).toEqual({
        kind: "passthrough",
      });
    });

    test("mailto: は passthrough", () => {
      expect(resolve("mailto:user@example.com", relBase("docs/preview.md"))).toEqual({
        kind: "passthrough",
      });
    });

    test("# 単独は passthrough (同一文書内アンカー)", () => {
      expect(resolve("#section", relBase("docs/preview.md"))).toEqual({ kind: "passthrough" });
      expect(resolve("#", relBase("docs/preview.md"))).toEqual({ kind: "passthrough" });
    });

    test("scheme 大文字小文字混在も passthrough", () => {
      expect(resolve("HTTPS://example.com/", relBase("docs/preview.md"))).toEqual({
        kind: "passthrough",
      });
      expect(resolve("Mailto:user@example.com", relBase("docs/preview.md"))).toEqual({
        kind: "passthrough",
      });
    });
  });

  describe("scheme allowlist 外 (invalid)", () => {
    test("gozd-rpc:// は invalid (RPC 経路への遷移を許可しない)", () => {
      expect(resolve("gozd-rpc://localhost/fs/readFile", relBase("docs/preview.md")).kind).toBe(
        "invalid",
      );
    });

    test("gozd-app:// は invalid (内部 asset scheme)", () => {
      expect(resolve("gozd-app://localhost/views/main/", relBase("docs/preview.md")).kind).toBe(
        "invalid",
      );
    });

    test("file:, data:, javascript: は invalid", () => {
      expect(resolve("file:///etc/passwd", relBase("docs/preview.md")).kind).toBe("invalid");
      expect(resolve("data:text/html,<h1>x</h1>", relBase("docs/preview.md")).kind).toBe("invalid");
      expect(resolve("javascript:alert(1)", relBase("docs/preview.md")).kind).toBe("invalid");
    });

    test("vscode:// 等の未許可 scheme は invalid", () => {
      expect(resolve("vscode://file/Users/foo", relBase("docs/preview.md")).kind).toBe("invalid");
    });
  });

  describe("internal (worktree 相対 basePath)", () => {
    test("./ 相対パスを basePath の dir 基準で解決する", () => {
      expectInternalRel("./workspace.md", relBase("docs/preview.md"), {
        relPath: "docs/workspace.md",
      });
    });

    test("../ で親ディレクトリに上がる", () => {
      expectInternalRel("../CLAUDE.md", relBase("docs/preview.md"), { relPath: "CLAUDE.md" });
    });

    test("名前のみのリンクは basePath の dir 基準で解決", () => {
      expectInternalRel("rpc.md", relBase("docs/preview.md"), { relPath: "docs/rpc.md" });
    });

    test("/ 始まりは worktree ルート相対", () => {
      expectInternalRel("/CLAUDE.md", relBase("docs/preview.md"), { relPath: "CLAUDE.md" });
    });

    test("root file から ./other.md は worktree root 基準で結合", () => {
      expectInternalRel("./other.md", relBase("README.md"), { relPath: "other.md" });
    });

    test("URL エンコードされたファイル名 (%20) を decode する", () => {
      expectInternalRel("./foo%20bar.md", relBase("docs/preview.md"), {
        relPath: "docs/foo bar.md",
      });
    });

    test("query string は path 部から落とす", () => {
      expectInternalRel("./foo.md?v=1", relBase("docs/preview.md"), { relPath: "docs/foo.md" });
    });

    test("basePath が undefined のときは worktree root 基準", () => {
      expectInternalRel("./README.md", undefined, { relPath: "README.md" });
    });

    test("`..` で始まる正当なファイル名は internal (worktree 外と誤検出しない)", () => {
      expectInternalRel("./..hidden.md", relBase("README.md"), { relPath: "..hidden.md" });
    });

    test("`..` 始まりのディレクトリ名も internal", () => {
      expectInternalRel("./..bak/foo.md", relBase("README.md"), { relPath: "..bak/foo.md" });
    });

    test("`~` 始まりの正当なファイル名は internal", () => {
      expectInternalRel("./~tmp.md", relBase("README.md"), { relPath: "~tmp.md" });
    });
  });

  describe("line fragment", () => {
    test("#L42 を lineNumber として抽出", () => {
      expectInternalRel("./foo.ts#L42", relBase("docs/preview.md"), {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#42 (L 無し) も lineNumber として抽出", () => {
      expectInternalRel("./foo.ts#42", relBase("docs/preview.md"), {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#L42,5 (列付き) は startLine だけ抽出", () => {
      expectInternalRel("./foo.ts#L42,5", relBase("docs/preview.md"), {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#L42-L50 (範囲) は startLine だけ抽出", () => {
      expectInternalRel("./foo.ts#L42-L50", relBase("docs/preview.md"), {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#section など行番号でない anchor は droppedAnchor: true", () => {
      expectInternalRel("./foo.md#installation", relBase("docs/preview.md"), {
        relPath: "docs/foo.md",
        droppedAnchor: true,
      });
    });

    test("#L0 は無効として droppedAnchor: true", () => {
      expectInternalRel("./foo.ts#L0", relBase("docs/preview.md"), {
        relPath: "docs/foo.ts",
        droppedAnchor: true,
      });
    });
  });

  describe("invalid", () => {
    test("空文字は invalid", () => {
      expect(resolve("", relBase("docs/preview.md"))).toEqual({
        kind: "invalid",
        reason: "Empty link target",
      });
    });

    test("?query 単独は invalid", () => {
      expect(resolve("?v=1", relBase("docs/preview.md")).kind).toBe("invalid");
    });

    test("空白のみは invalid", () => {
      expect(resolve("   ", relBase("docs/preview.md")).kind).toBe("invalid");
    });

    test("不正な URL エンコーディング (%ZZ) は invalid", () => {
      expect(resolve("./foo%ZZ.md", relBase("docs/preview.md")).kind).toBe("invalid");
    });

    test("worktree 外を指す ../ は invalid", () => {
      expect(resolve("../../etc/passwd", relBase("README.md")).kind).toBe("invalid");
    });

    test("深いネスト経由でも worktree 外は invalid", () => {
      expect(resolve("../../../etc/passwd", relBase("docs/preview.md")).kind).toBe("invalid");
    });

    test("`~/` 始まりは worktree 外 (home 参照) として invalid", () => {
      expect(resolve("~/secret.md", relBase("README.md")).kind).toBe("invalid");
    });

    test("`./~/foo.md` は normalize 後に `~/` 始まりとなり invalid", () => {
      expect(resolve("./~/foo.md", relBase("README.md")).kind).toBe("invalid");
    });

    test("`~` 単独も invalid", () => {
      expect(resolve("~", relBase("README.md")).kind).toBe("invalid");
    });
  });

  describe("absolute basePath (worktree 外 markdown を terminal link から開いた経路)", () => {
    test("相対リンクは絶対 basePath dir 内に absolute selection として解決する", () => {
      expectInternalAbs("./image.png", absBase("/Users/me/elsewhere/README.md"), {
        absPath: "/Users/me/elsewhere/image.png",
      });
    });

    test("子ディレクトリへの相対リンクは internal", () => {
      expectInternalAbs("./images/x.png", absBase("/Users/me/elsewhere/README.md"), {
        absPath: "/Users/me/elsewhere/images/x.png",
      });
    });

    test("`../` で basePath dir を抜けるリンクは invalid (信頼境界縮小)", () => {
      expect(resolve("../sibling.md", absBase("/Users/me/elsewhere/docs/README.md")).kind).toBe(
        "invalid",
      );
    });

    test("行番号 fragment も absolute base 経路で抽出される", () => {
      expectInternalAbs("./foo.ts#L42", absBase("/Users/me/elsewhere/README.md"), {
        absPath: "/Users/me/elsewhere/foo.ts",
        lineNumber: 42,
      });
    });

    test("`/` 始まりの絶対パスは basePath dir 配下でない限り invalid (path traversal block)", () => {
      expect(resolve("/Users/me/other/foo.md", absBase("/Users/me/elsewhere/README.md")).kind).toBe(
        "invalid",
      );
    });

    test("`/etc/passwd` 系の絶対パスは basePath dir を抜けるため invalid", () => {
      expect(resolve("/etc/passwd", absBase("/Users/me/elsewhere/README.md")).kind).toBe("invalid");
    });

    test("`../../etc/passwd` 系の相対 traversal も basePath dir を抜けると invalid", () => {
      expect(resolve("../../etc/passwd", absBase("/Users/me/elsewhere/README.md")).kind).toBe(
        "invalid",
      );
    });

    test("basePath dir そのもの (末尾 `/`) を指すリンクは invalid (ディレクトリ参照)", () => {
      expect(resolve("./", absBase("/Users/me/elsewhere/README.md")).kind).toBe("invalid");
    });

    describe("root 直下の絶対 basePath (`/foo.md` 等の退化ケース)", () => {
      const rootBase = absBase("/foo.md");

      test("sibling 参照 (`./bar.md`) は `/bar.md` として internal", () => {
        expectInternalAbs("./bar.md", rootBase, { absPath: "/bar.md" });
      });

      test("root 直下の絶対パス (`/bar.md`) も internal", () => {
        expectInternalAbs("/bar.md", rootBase, { absPath: "/bar.md" });
      });

      test("root 直下に居ても `/etc/passwd` 等 sub-dir 配下は invalid (bypass 防止)", () => {
        expect(resolve("/etc/passwd", rootBase).kind).toBe("invalid");
      });

      test("root 直下に居ても `./foo/bar.md` のような子 dir 経路は invalid", () => {
        expect(resolve("./foo/bar.md", rootBase).kind).toBe("invalid");
      });
    });
  });
});
