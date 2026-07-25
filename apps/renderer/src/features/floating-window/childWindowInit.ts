/**
 * 別 OS ウィンドウ (ChildWindow) の生成パラメータと、main window 内の viewport rect からの換算。
 */

/**
 * OS child window の生成パラメータ。昇格元 (in-app パネル) の実測コンテンツ rect をスクリーン
 * 座標へ換算した値で、パネルがその場で OS ウィンドウ化したような視覚的連続性を出す。
 * width / height はコンテンツサイズ (titlebar 分の外枠換算は ChildWindow が行う)。
 * 生成後の位置 / サイズ / 前面順は OS が SSOT で、永続化しない (undocked window は揮発的)。
 */
export interface ChildWindowInit {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}

/**
 * main window 内の viewport rect を ChildWindowInit へ換算する。
 *
 * `window.screenX` / `screenY` は OS ウィンドウ**外枠**の原点なので、コンテンツ原点とのずれ
 * (titlebar 等の chrome 高) を outer / inner の差で補正する。
 */
export function toChildWindowInit(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): ChildWindowInit {
  const chromeY = window.outerHeight - window.innerHeight;
  return {
    screenX: window.screenX + rect.left,
    screenY: window.screenY + chromeY + rect.top,
    width: rect.width,
    height: rect.height,
  };
}
