import { describe, expect, test } from "bun:test";
import type { PathTarget } from "../worktree";
import { resolveMarkdownLink } from "./resolveMarkdownLink";

/**
 * `relDirOf` / `normalizeRelative` / `normalizeAbsolute` の挙動は別ファイル
 * (`filer/relDirOf.test.ts`, `worktree/pathUtils.test.ts`) で SSOT としてテスト済み。
 *
 * 本来は barrel 経由 (`../filer` / `../worktree`) で本物を import して挙動差を消したいが、
 * worktree barrel は `useWorktreeStore` 等のロードで `window.__gozdReceive` を参照する
 * shared/rpc モジュールを芋づる式に取り込むため bun:test 環境で失敗する。
 * barrel-import ルールにより別 feature の内部モジュール (`../filer/relDirOf`) を直接
 * import することも禁止されている。
 *
 * 折衷案として `pathUtils.ts:normalizeRelative` / `normalizeAbsolute` / `relDirOf.ts` の
 * ロジックを inline fake で完全に写し取る。本物との挙動差が出ないことは仕様の一致で担保する。
 */
function fakeRelDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.substring(0, idx);
}

function fakeNormalizeRelative(relPath: string): string {
  const segments = relPath.split("/").filter((s) => s !== "");
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else {
        result.push("..");
      }
      continue;
    }
    result.push(seg);
  }
  return result.join("/");
}

function fakeNormalizeAbsolute(absPath: string): string {
  const segments = absPath.split("/").filter((s) => s !== "");
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (result.length > 0) result.pop();
      continue;
    }
    result.push(seg);
  }
  return `/${result.join("/")}`;
}

/** テスト用: 文字列を PathTarget に持ち上げる (string sniff はテスト fake の中だけに閉じる) */
function asBasePath(path: string | undefined): PathTarget | undefined {
  if (path === undefined) return undefined;
  if (path.startsWith("/")) return { kind: "absolute", absPath: path };
  return { kind: "worktreeRelative", relPath: path };
}

function resolve(href: string, basePath: string | undefined) {
  return resolveMarkdownLink({
    href,
    basePath: asBasePath(basePath),
    relDirOf: fakeRelDirOf,
    normalizeRelative: fakeNormalizeRelative,
    normalizeAbsolute: fakeNormalizeAbsolute,
  });
}

function expectInternalRel(
  href: string,
  basePath: string | undefined,
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
  basePath: string | undefined,
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

  describe("internal (worktree 相対 basePath)", () => {
    test("./ 相対パスを basePath の dir 基準で解決する", () => {
      expectInternalRel("./workspace.md", "docs/preview.md", { relPath: "docs/workspace.md" });
    });

    test("../ で親ディレクトリに上がる", () => {
      expectInternalRel("../CLAUDE.md", "docs/preview.md", { relPath: "CLAUDE.md" });
    });

    test("名前のみのリンクは basePath の dir 基準で解決", () => {
      expectInternalRel("rpc.md", "docs/preview.md", { relPath: "docs/rpc.md" });
    });

    test("/ 始まりは worktree ルート相対", () => {
      expectInternalRel("/CLAUDE.md", "docs/preview.md", { relPath: "CLAUDE.md" });
    });

    test("root file から ./other.md は worktree root 基準で結合", () => {
      expectInternalRel("./other.md", "README.md", { relPath: "other.md" });
    });

    test("URL エンコードされたファイル名 (%20) を decode する", () => {
      expectInternalRel("./foo%20bar.md", "docs/preview.md", { relPath: "docs/foo bar.md" });
    });

    test("query string は path 部から落とす", () => {
      expectInternalRel("./foo.md?v=1", "docs/preview.md", { relPath: "docs/foo.md" });
    });

    test("basePath が undefined のときは worktree root 基準", () => {
      expectInternalRel("./README.md", undefined, { relPath: "README.md" });
    });

    test("`..` で始まる正当なファイル名は internal (worktree 外と誤検出しない)", () => {
      expectInternalRel("./..hidden.md", "README.md", { relPath: "..hidden.md" });
    });

    test("`..` 始まりのディレクトリ名も internal", () => {
      expectInternalRel("./..bak/foo.md", "README.md", { relPath: "..bak/foo.md" });
    });

    test("`~` 始まりの正当なファイル名は internal", () => {
      expectInternalRel("./~tmp.md", "README.md", { relPath: "~tmp.md" });
    });
  });

  describe("line fragment", () => {
    test("#L42 を lineNumber として抽出", () => {
      expectInternalRel("./foo.ts#L42", "docs/preview.md", {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#42 (L 無し) も lineNumber として抽出", () => {
      expectInternalRel("./foo.ts#42", "docs/preview.md", {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#L42,5 (列付き) は startLine だけ抽出", () => {
      expectInternalRel("./foo.ts#L42,5", "docs/preview.md", {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#L42-L50 (範囲) は startLine だけ抽出", () => {
      expectInternalRel("./foo.ts#L42-L50", "docs/preview.md", {
        relPath: "docs/foo.ts",
        lineNumber: 42,
      });
    });

    test("#section など行番号でない anchor は droppedAnchor: true", () => {
      expectInternalRel("./foo.md#installation", "docs/preview.md", {
        relPath: "docs/foo.md",
        droppedAnchor: true,
      });
    });

    test("#L0 は無効として droppedAnchor: true", () => {
      expectInternalRel("./foo.ts#L0", "docs/preview.md", {
        relPath: "docs/foo.ts",
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

    test("`~/` 始まりは worktree 外 (home 参照) として invalid", () => {
      expect(resolve("~/secret.md", "README.md").kind).toBe("invalid");
    });

    test("`./~/foo.md` は normalize 後に `~/` 始まりとなり invalid", () => {
      expect(resolve("./~/foo.md", "README.md").kind).toBe("invalid");
    });

    test("`~` 単独も invalid", () => {
      expect(resolve("~", "README.md").kind).toBe("invalid");
    });
  });

  describe("absolute basePath (worktree 外 markdown を terminal link から開いた経路)", () => {
    test("相対リンクは絶対 basePath dir 内に absolute selection として解決する", () => {
      expectInternalAbs("./image.png", "/Users/me/elsewhere/README.md", {
        absPath: "/Users/me/elsewhere/image.png",
      });
    });

    test("子ディレクトリへの相対リンクは internal", () => {
      expectInternalAbs("./images/x.png", "/Users/me/elsewhere/README.md", {
        absPath: "/Users/me/elsewhere/images/x.png",
      });
    });

    test("`../` で basePath dir を抜けるリンクは invalid (信頼境界縮小)", () => {
      expect(resolve("../sibling.md", "/Users/me/elsewhere/docs/README.md").kind).toBe("invalid");
    });

    test("行番号 fragment も absolute base 経路で抽出される", () => {
      expectInternalAbs("./foo.ts#L42", "/Users/me/elsewhere/README.md", {
        absPath: "/Users/me/elsewhere/foo.ts",
        lineNumber: 42,
      });
    });

    test("`/` 始まりの絶対パスは basePath dir 配下でない限り invalid (path traversal block)", () => {
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
      expect(resolve("./", "/Users/me/elsewhere/README.md").kind).toBe("invalid");
    });

    describe("root 直下の絶対 basePath (`/foo.md` 等の退化ケース)", () => {
      const rootBase = "/foo.md";

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
