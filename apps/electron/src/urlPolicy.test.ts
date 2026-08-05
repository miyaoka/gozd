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

  test("大文字 scheme も内部 (scheme の大小は URL の同一性を変えない)", () => {
    expect(isRendererOrigin("HTTP://localhost:5173/src/main.ts", RENDERER_ORIGIN)).toBe(true);
    expect(isRendererOrigin("HttP://localhost:5173/", RENDERER_ORIGIN)).toBe(true);
  });

  test("blob: は内部でない (origin が inner origin を返すので origin 比較だけでは通る)", () => {
    expect(isRendererOrigin("blob:http://localhost:5173/abcd", RENDERER_ORIGIN)).toBe(false);
  });

  test("parse 不能な文字列は外部側に倒す", () => {
    expect(isRendererOrigin("not a url", RENDERER_ORIGIN)).toBe(false);
  });
});

describe("decideFrameNavigation", () => {
  const CURRENT_URL = `${RENDERER_ORIGIN}/index.html`;
  const decide = (url: string, isMainFrame: boolean, rendererOrigin = RENDERER_ORIGIN) =>
    decideFrameNavigation({ url, isMainFrame, currentUrl: CURRENT_URL, rendererOrigin });

  describe("main frame", () => {
    test("dev の Vite origin への同一 URL 遷移は allow (location.reload を止めない)", () => {
      expect(decide(CURRENT_URL, true)).toBe("allow");
    });

    test("dev の Vite origin でも別 path は block (rendered content からの UI 面置換)", () => {
      expect(decide(`${RENDERER_ORIGIN}/src/main.ts`, true)).toBe("block");
    });

    test("外部 http(s) は block (OS へ渡すのは renderer の openExternal の責務)", () => {
      expect(decide("https://example.com/", true)).toBe("block");
    });

    test("mailto: も block", () => {
      expect(decide("mailto:user@example.com", true)).toBe("block");
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
  });

  describe("subframe (HTML preview の iframe)", () => {
    test("gozd-preview:// 内の遷移は allow (previewed HTML の相対リンク)", () => {
      // host 部は preview instance の id。origin を preview ごとに分けるため固定値ではない
      expect(
        decide("gozd-preview://0b7b1e2c-1111-4222-8333-444455556666/Users/x/repo/a.html", false),
      ).toBe("allow");
    });

    test("配信側が解釈できない gozd-preview:// は block (host 部の preview id が無い)", () => {
      expect(decide("gozd-preview:///Users/x/repo/a.html", false)).toBe("block");
    });

    test("外部 http(s) は external (この frame のクリックを受け取れる層が他に無い)", () => {
      expect(decide("https://example.com/", false)).toBe("external");
      expect(decide("http://example.com/", false)).toBe("external");
    });

    test("dev の Vite origin は同一 URL でも block (プレビュー面を動かさない)", () => {
      expect(decide(CURRENT_URL, false)).toBe("block");
      expect(decide(`${RENDERER_ORIGIN}/page2.html`, false)).toBe("block");
    });

    test("大文字 scheme の Vite origin も block (外部送りに落ちない)", () => {
      expect(decide("HTTP://localhost:5173/page2.html", false)).toBe("block");
    });

    test("mailto: は external (この frame はクリックを傍受できず、ここが唯一の受け取り口)", () => {
      expect(decide("mailto:user@example.com", false)).toBe("external");
    });

    test("外部送りの scheme 集合は renderer 側 allowlist と同一 (それ以外は block)", () => {
      expect(decide("ftp://example.com/", false)).toBe("block");
      expect(decide("tel:+81000000000", false)).toBe("block");
      expect(decide("javascript:alert(1)", false)).toBe("block");
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
