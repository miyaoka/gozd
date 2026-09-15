/**
 * `update` による DOM 変更の前後で、`target` の画面上の縦位置が変わらないよう `scroller` の
 * スクロール量を補正する。押した要素の近くに内容が差し込まれる / 取り除かれる操作 (開閉トグル等) で、
 * 押した要素をポインタの下に留めるために使う。
 *
 * ブラウザの scroll anchoring には任せない。スクロール位置が origin (`flex-direction:
 * column-reverse` では末尾) にある間は anchoring が anchor を選ばず、差し込んだ高さの分だけ要素が
 * 動く。origin から離れている間は anchoring が自分で選んだ anchor を基準に補正し、`target` がその
 * anchor でなければ `target` は動く。どちらの場合も、補正後の位置を測ってから差を足すので二重には
 * 動かない。
 *
 * 戻せるのはスクロール面が溢れている範囲だけで、溢れていないスクロール面そのものが伸び縮みして
 * 要素が動く分は戻せない。それは差し込む位置を選んで避ける。
 */
export async function keepInPlace(
  target: HTMLElement,
  scroller: HTMLElement,
  update: () => Promise<void>,
): Promise<void> {
  const before = target.getBoundingClientRect().top;
  await update();
  scroller.scrollTop += target.getBoundingClientRect().top - before;
}
