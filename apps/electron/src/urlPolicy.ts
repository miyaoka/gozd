// installExternalLinkPolicy (main.ts) の URL 判定。セキュリティ境界のため純関数に切り出して
// バイパス文字列の回帰テストを可能にする (urlPolicy.test.ts)。
//
// 「この URL を OS に渡してよいか」は、原則としてリンククリックを**受け取れる層**が決める。
// main frame では renderer のコードが動くのでそちら (`shared/rpc` の openExternal) が担い、
// この層は「frame を動かさせない」ことだけをする (VS Code の will-navigate ハンドラが URL を
// 見ずに preventDefault するのと同じ切り方)。
//
// 例外が HTML preview の `<iframe srcdoc sandbox="">`。opaque origin かつスクリプト不可なので
// 親からクリックを傍受できず、受け取れる層がこの防壁しか無い。VS Code の webview iframe は
// sandbox に `allow-same-origin` を持つため host からハンドラを注入できるが、gozd は sandbox
// 契約 (親 origin を継承させない = RPC bridge に到達させない) と両立しないためその手が使えない。
// よって subframe に限り、この層が外部送りまで担う。
import { tryCatch } from "@gozd/shared";

/**
 * dev の Vite origin か。origin は完全一致で比較する。prefix 比較
 * (`url.startsWith(rendererUrl)`) だと `http://localhost:5173.evil.example` や
 * `http://localhost:5173@evil.example` (userinfo 扱い) のようなホスト偽装が内部扱いになり、
 * 境界を突破される。
 *
 * rendererOrigin が undefined なのは packaged で、その場合は一致する URL が存在しない。
 *
 * origin 一致の前に scheme を http(s) に固定する。`new URL("blob:http://host/…").origin` は
 * blob の inner origin (`http://host`) を返すため、origin 比較だけだと `blob:` が内部扱いになる。
 * Vite dev server の URL は必ず http(s) なので、scheme を固定しても取りこぼしはない。
 */
export function isRendererOrigin(url: string, rendererOrigin: string | undefined): boolean {
  if (rendererOrigin === undefined) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  const parsed = tryCatch(() => new URL(url));
  // parse 不能な文字列は内部と証明できないため外部側に倒す
  if (!parsed.ok) return false;
  return parsed.value.origin === rendererOrigin;
}

/** frame 遷移の扱い。`external` は遷移を止めた上で OS に渡す。 */
export type FrameNavigationVerdict = "allow" | "external" | "block";

/**
 * frame 遷移の判定。**原則すべて block** し、例外だけを開ける。
 *
 * 例外は dev の Vite origin への **main frame の再読み込み** だけ。Vite の full reload は
 * `location.reload()` で、これは `will-frame-navigate` を発火するため止めると HMR が壊れる。
 * 例外を「同一 URL への遷移」に絞るのは、同 origin の別 path を通すと rendered content
 * （session log の assistant markdown 等）の root-relative リンクが dev で Vite origin に解決され、
 * UI 面が SPA fallback に置換されるため。packaged は `loadFile` で読み込み、リロードも
 * webContents API 経由でこの判定に到達しないので、例外は dev だけに閉じる。
 *
 * subframe は HTML preview の `<iframe srcdoc sandbox="">` だけで、初期 srcdoc から動かないのが
 * 契約。内部 origin であっても遷移すればプレビュー面を奪う (dev では previewed HTML の相対
 * リンクが Vite origin に解決され SPA fallback の index.html が返る。sandbox でスクリプトが
 * 動かないので白面になる)。ただし外部 http(s) だけは `external` で OS に逃がす —
 * この frame のリンククリックを受け取れる層が他に無いため (ファイル冒頭の注記)。
 * mailto 等の external protocol は Chromium / Electron 自身が sandboxed frame から塞いでおり、
 * 防壁が肩代わりするとその保護を迂回するので http(s) に絞る。
 *
 * 一律 block が HTML preview / undock child window を殺さないのは、`about:srcdoc` や
 * `about:blank` のように URLLoader を経由しない commit がこの判定に到達しないため。到達する
 * ようになるとプレビューは全面が空になり、child window は投影前の文書を失う。手がかりは block の
 * stderr 1 行だけになる。
 */
export function decideFrameNavigation({
  url,
  isMainFrame,
  currentUrl,
  rendererOrigin,
}: {
  url: string;
  isMainFrame: boolean;
  /**
   * webContents の **main frame** が現在読んでいる URL (`contents.getURL()`)。full reload の
   * 判定に使う。subframe 遷移のときも main frame の URL が入るため、subframe 分岐で
   * 「その frame の現在 URL」として読んではいけない。
   */
  currentUrl: string;
  rendererOrigin: string | undefined;
}): FrameNavigationVerdict {
  if (!isMainFrame) {
    // 内部 origin は「外部」ではない。dev では previewed HTML の相対リンクがここに解決されるため、
    // 外部送りすると意図しないブラウザ起動になる
    if (isRendererOrigin(url, rendererOrigin)) return "block";
    return url.startsWith("http://") || url.startsWith("https://") ? "external" : "block";
  }
  return url === currentUrl && isRendererOrigin(url, rendererOrigin) ? "allow" : "block";
}
