/**
 * EditContext のイベント列を「端末へ送る文字列」と「変換中の表示」に畳む状態機械。
 * EditContext の現在の text は呼び出し側がイベントに添えて渡す（EditContext が text の SSOT）。
 *
 * ## 不変条件
 *
 * 1. 変換中でないとき、EditContext の text は空。直接入力も確定も、送ると同時に `clear-buffer`
 *    を出す。これにより textformatupdate の範囲が、そのまま変換中文字列上の位置になる
 * 2. 確定文字列は compositionend でだけ送る。変換中の textupdate は表示を更新するだけ
 *
 * compositionstart が変換の最初の textupdate より先に届くことは、CDP の変換（Input.imeSetComposition）で
 * 確認している。
 */

export type ImeTextFormat = Pick<
  TextFormat,
  "rangeStart" | "rangeEnd" | "underlineStyle" | "underlineThickness"
>;

export type TextInputState = {
  composing: boolean;
  /** 変換中の文字列。変換中でなければ "" */
  preedit: string;
  /** 最後に受けた textformatupdate の範囲。preedit 上の位置 */
  formats: readonly ImeTextFormat[];
};

export type TextInputEvent =
  | { type: "compositionstart" }
  /** `bufferText` は EditContext がこの更新を適用した後の text */
  | { type: "textupdate"; bufferText: string }
  | { type: "textformatupdate"; formats: readonly ImeTextFormat[] }
  /** `bufferText` は compositionend 時点の EditContext の text（= 確定文字列） */
  | { type: "compositionend"; bufferText: string };

export type TextInputEffect =
  /** 端末へ利用者の入力として送る */
  | { kind: "send"; data: string }
  /** EditContext の text と selection を空に戻す（不変条件 1） */
  | { kind: "clear-buffer" };

export type TextInputStep = { state: TextInputState; effects: readonly TextInputEffect[] };

export const INITIAL_TEXT_INPUT_STATE: TextInputState = {
  composing: false,
  preedit: "",
  formats: [],
};

function sendAndClear(text: string): readonly TextInputEffect[] {
  if (text === "") return [{ kind: "clear-buffer" }];
  return [{ kind: "send", data: text }, { kind: "clear-buffer" }];
}

export function reduceTextInput(state: TextInputState, event: TextInputEvent): TextInputStep {
  switch (event.type) {
    case "compositionstart":
      return { state: { composing: true, preedit: "", formats: [] }, effects: [] };
    case "textupdate":
      // 変換を伴わない入力。xterm が引き受けなかったキーの文字がここに来る
      if (!state.composing) return { state, effects: sendAndClear(event.bufferText) };
      return { state: { ...state, preedit: event.bufferText }, effects: [] };
    case "textformatupdate":
      if (!state.composing) return { state, effects: [] };
      return { state: { ...state, formats: event.formats }, effects: [] };
    case "compositionend":
      return { state: INITIAL_TEXT_INPUT_STATE, effects: sendAndClear(event.bufferText) };
  }
}

export type PreeditUnderline = {
  thickness: "thin" | "thick";
  style: "solid" | "dotted" | "dashed" | "wavy";
};

/** 変換中文字列を下線の種類で区切った 1 区間 */
export type PreeditRun = {
  /** preedit 上の開始位置 */
  start: number;
  text: string;
  /** 下線を引かない区間は undefined */
  underline: PreeditUnderline | undefined;
};

function toUnderline(format: ImeTextFormat | undefined): PreeditUnderline | undefined {
  if (format === undefined) return undefined;
  if (format.underlineThickness === "none" || format.underlineStyle === "none") return undefined;
  return { thickness: format.underlineThickness, style: format.underlineStyle };
}

/**
 * preedit を formats の境界で切り、隙間なく並んだ区間の列にする。
 *
 * - 返り値の text を連結すると preedit に一致する
 * - preedit の外を指す範囲は preedit の長さで切り詰める。範囲が重なっていたら後のものを使う
 */
export function toPreeditRuns(preedit: string, formats: readonly ImeTextFormat[]): PreeditRun[] {
  const clamp = (n: number) => Math.min(Math.max(n, 0), preedit.length);
  const boundaries = [
    ...new Set([
      0,
      preedit.length,
      ...formats.flatMap((f) => [clamp(f.rangeStart), clamp(f.rangeEnd)]),
    ]),
  ].toSorted((a, b) => a - b);

  const runs: PreeditRun[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (start === undefined || end === undefined || start >= end) continue;
    const format = formats.findLast((f) => f.rangeStart <= start && end <= f.rangeEnd);
    runs.push({ start, text: preedit.slice(start, end), underline: toUnderline(format) });
  }
  return runs;
}
