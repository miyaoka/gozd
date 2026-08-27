/**
 * 直近に測定が成立した端末の桁数 / 行数。表示されていない端末の起動寸法に使う。
 *
 * 契約は docs/terminal.md。ここが持つのは「なぜ固定値ではないか」だけ。
 *
 * 起動寸法は近似でよい。可視化の時点で実寸に合わせ直されるため、必要なのは正確さではなく、
 * 起動から可視化までに書き出される出力が読める幅であること。固定値は端末領域の実寸と無関係に
 * ずれ続けるが、直近の測定値は同じ領域を分け合った実測なので、実用になる桁数に収まる。
 */
type TerminalGeometry = { cols: number; rows: number };

let lastGeometry: TerminalGeometry | undefined;

/** 測定が成立したときに呼ぶ */
export function recordTerminalGeometry(cols: number, rows: number): void {
  lastGeometry = { cols, rows };
}

/** 測定できない端末の起動寸法。測定実績が無ければ undefined */
export function getLastTerminalGeometry(): TerminalGeometry | undefined {
  return lastGeometry;
}
