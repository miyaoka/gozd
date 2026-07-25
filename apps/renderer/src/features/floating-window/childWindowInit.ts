/**
 * 別 OS ウィンドウ (ChildWindow) の生成パラメータと、main window 内 rect からの換算。
 *
 * 換算は昇格位置の SSOT なので、`window` の読み取り (呼び出し側の責務) と算術を分けて純関数に
 * している (floatingWindowResize と同じ規律。境界値は単体テストで固定する)。
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

/** main window のスクリーン原点。`screenX` / `screenY` は OS ウィンドウ**外枠**の原点なので、
 * コンテンツ原点とのずれ (titlebar 等の chrome 高) を `chromeY` で受けて補正する。 */
export interface WindowScreenOrigin {
  screenX: number;
  screenY: number;
  chromeY: number;
}

/** main window 内の viewport rect を ChildWindowInit へ換算する (doc 参照)。 */
export function toChildWindowInit(
  rect: { left: number; top: number; width: number; height: number },
  origin: WindowScreenOrigin,
): ChildWindowInit {
  return {
    screenX: origin.screenX + rect.left,
    screenY: origin.screenY + origin.chromeY + rect.top,
    width: rect.width,
    height: rect.height,
  };
}
