// 外部送り境界の回帰テスト。origin 判定 (isRendererOrigin が完全一致であることを既知のバイパス
// 文字列で固定する。prefix 比較へ差し戻すと fail する) と、frame 役割ごとの遷移判定を守る。
import { describe, expect, test } from "bun:test";
import { decideFrameNavigation, isRendererOrigin } from "./urlPolicy";

const RENDERER_ORIGIN = "http://localhost:5173";

describe("isRendererOrigin", () => {
  test("同一 origin は内部", () => {
    expect(isRendererOrigin("http://localhost:5173/src/main.ts", RENDERER_ORIGIN)).toBe(true);
  });

  test("origin の後続にホストを継ぎ足した偽装は外部", () => {
    expect(isRendererOrigin("http://localhost:5173.evil.example/", RENDERER_ORIGIN)).toBe(false);
  });

  test("renderer origin を userinfo に落とす偽装は外部", () => {
    expect(isRendererOrigin("http://localhost:5173@evil.example/", RENDERER_ORIGIN)).toBe(false);
  });

  test("scheme 違い (https) は同一 host でも外部 (origin は scheme を含む)", () => {
    expect(isRendererOrigin("https://localhost:5173/", RENDERER_ORIGIN)).toBe(false);
  });

  test("packaged (rendererOrigin 不在) はどの URL も一致しない", () => {
    expect(isRendererOrigin("file:///Applications/Gozd.app/renderer/index.html", undefined)).toBe(
      false,
    );
  });

  test("parse 不能な文字列は外部側に倒す", () => {
    expect(isRendererOrigin("not a url", RENDERER_ORIGIN)).toBe(false);
  });
});

describe("decideFrameNavigation", () => {
  const decide = (url: string, isMainFrame: boolean, rendererOrigin = RENDERER_ORIGIN) =>
    decideFrameNavigation({ url, isMainFrame, rendererOrigin });

  describe("main frame", () => {
    test("dev の Vite origin は allow (location.reload によるフルリロードを止めない)", () => {
      expect(decide("http://localhost:5173/src/main.ts", true)).toBe("allow");
    });

    test("外部 http(s) は external", () => {
      expect(decide("https://example.com/", true)).toBe("external");
    });

    test("packaged の file: は block (renderer は loadFile 経由でこの判定に到達しない)", () => {
      expect(decide("file:///Applications/Gozd.app/renderer/index.html", true, undefined)).toBe(
        "block",
      );
    });

    test("任意の file: は block (ローカルファイルを UI 面に描画させない)", () => {
      expect(decide("file:///Users/somebody/.ssh/id_rsa", true, undefined)).toBe("block");
      expect(decide("file:///etc/passwd", true)).toBe("block");
    });

    test("data: / blob: は block", () => {
      expect(decide("data:text/html,<h1>x</h1>", true)).toBe("block");
      expect(decide("blob:http://localhost:5173/abcd", true)).toBe("block");
    });

    test("mailto: 等の非 http scheme も block (外部送りは openExternal RPC の責務)", () => {
      expect(decide("mailto:user@example.com", true)).toBe("block");
    });
  });

  describe("subframe (HTML preview の sandboxed iframe)", () => {
    test("外部 http(s) は external", () => {
      expect(decide("https://example.com/", false)).toBe("external");
    });

    test("dev の Vite origin も block (SPA fallback がプレビュー面を奪う)", () => {
      expect(decide("http://localhost:5173/page2.html", false)).toBe("block");
    });

    test("file: は block (プレビュー面でローカルファイルを描画させない)", () => {
      expect(decide("file:///Users/somebody/.ssh/id_rsa", false, undefined)).toBe("block");
    });

    test("data: / blob: は block", () => {
      expect(decide("data:text/html,<h1>x</h1>", false)).toBe("block");
      expect(decide("blob:http://localhost:5173/abcd", false)).toBe("block");
    });
  });
});
