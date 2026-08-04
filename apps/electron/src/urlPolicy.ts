// installExternalLinkPolicy (main.ts) の URL 判定。セキュリティ境界のため純関数に切り出して
// バイパス文字列の回帰テストを可能にする (urlPolicy.test.ts)。
//
// 「この URL を OS に渡してよいか」は、原則としてリンククリックを**受け取れる層**が決める。
// main frame では renderer のコードが動くのでそちら (`shared/rpc` の openExternal) が担い、
// この層は「frame を動かさせない」ことだけをする (VS Code の will-navigate ハンドラが URL を
// 見ずに preventDefault するのと同じ切り方)。
//
// 例外が HTML preview の iframe。previewed HTML は `gozd-preview://` の実 origin で配信され
// (previewProtocol.ts)、その中の script は CSP で止めてある。renderer からクリックを傍受する
// 経路が無いため、外部送りはこの層が担う。
import { tryCatch } from "@gozd/shared";
import { PREVIEW_SCHEME } from "./previewScheme";

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
/** http(s) スキームか。origin 判定と外部送り判定が同じ述語を共有する */
function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function isRendererOrigin(url: string, rendererOrigin: string | undefined): boolean {
  if (rendererOrigin === undefined) return false;
  if (!isHttpUrl(url)) return false;
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
 * subframe は HTML preview の iframe だけ。`gozd-preview://` 内の遷移は previewed HTML の
 * 相対リンクなので許可する (配信範囲は previewProtocol の登録 root に絞られており、root 外は
 * 配信自体が 403 になる)。外部 http(s) は `external` で OS に逃がす — この frame のリンク
 * クリックを受け取れる層が他に無いため (ファイル冒頭の注記)。それ以外は block。
 *
 * 一律 block が undock child window を殺さないのは、`about:blank` のように URLLoader を
 * 経由しない commit がこの判定に到達しないため。到達するようになると child window は投影前の
 * 文書を失う。手がかりは block の stderr 1 行だけになる。
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
    // previewed HTML の相対リンク。配信 root 外は protocol handler が 403 にする
    if (url.startsWith(`${PREVIEW_SCHEME}://`)) return "allow";
    // 内部 origin は「外部」ではない。dev では previewed HTML の絶対リンクがここに解決され得るため、
    // 外部送りすると意図しないブラウザ起動になる
    if (isRendererOrigin(url, rendererOrigin)) return "block";
    return isHttpUrl(url) ? "external" : "block";
  }
  return url === currentUrl && isRendererOrigin(url, rendererOrigin) ? "allow" : "block";
}
