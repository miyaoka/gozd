import type { IMarker } from "@xterm/xterm";

/**
 * cwdTracker が必要とする最小の terminal 契約。test で fake を注入するために絞る
 * （`Terminal` は構造的に代入可能）。返り値を `| undefined` に広げているのは、
 * xterm の実装が marker を作れない状況で undefined を返しうるため
 * （d.ts は `IMarker` 固定だが実挙動に合わせる。XtermTerminal.vue の既存 guard と同じ前提）
 */
export interface CwdMarkerHost {
  registerMarker(cursorYOffset?: number): IMarker | undefined;
}

export interface CwdTracker {
  /** OSC 7 受信時に呼ぶ。現在のカーソル行に cwd 遷移を記録する */
  observe(cwd: string): void;
  /** バッファ絶対行（0-based）の出力時点で有効だった cwd を返す。不明なら undefined */
  cwdAtLine(bufferLine: number): string | undefined;
}

/**
 * シェル cwd の遷移を「遷移が起きたバッファ行」つきで保持し、行ごとに出力時点の cwd を
 * 引けるようにする。
 *
 * 最新 cwd の単一値だけを持つと、cd 後にスクロールバックへ残った古い出力の相対パスリンクが
 * 最新 cwd 基準で誤解決する（root で出力 → cd サブディレクトリ → 古いリンクをクリック、で
 * パスが二重に join される）。遷移位置を xterm の Marker で持つことで、scrollback trim /
 * resize reflow による行移動へ構造的に追従する（自前の行番号補正をしない）。
 *
 * - 遷移列は marker.line 昇順（observe はカーソル行 = 常にバッファ末尾側に積む）
 * - marker の dispose は 2 系統ある: scrollback trim（最古から順に消える）と resize reflow
 *   （行統合で中間の marker も消えうる）。最古の dispose のみ cwd を baseline
 *   （バッファ先頭からの適用値）へ昇格して残存行の帰属を保ち、中間の dispose は該当遷移
 *   だけ除去して破棄領域を直前の遷移の cwd に縮退させる（無関係な古い領域を壊さない）
 * - 遷移を一度も観測していない領域（最初の遷移より前の行）は undefined を返し、
 *   呼び出し側が worktree root 基準に fallback する
 * - Marker は terminal インスタンスに紐づくため、遷移列は store に置かず component と同じ
 *   ライフサイクルで持つ。再マウント時は ring buffer replay が OSC 7 を再発火して再構築する
 */
export function createCwdTracker(terminal: CwdMarkerHost): CwdTracker {
  const transitions: { marker: IMarker; cwd: string }[] = [];
  let baselineCwd: string | undefined;

  return {
    observe(cwd) {
      // zsh chpwd は変化時のみ発火するが、同一 cwd の連続通知は遷移にしない
      const [last] = transitions.slice(-1);
      if (last !== undefined && last.cwd === cwd) return;
      if (last === undefined && baselineCwd === cwd) return;

      const marker = terminal.registerMarker(0);
      if (marker === undefined) {
        // 遷移位置が取れない異常系（dispose 済み terminal 等）は全行適用の近似に倒す
        console.error(`[cwdTracker] registerMarker failed, degrading to baseline cwd=${cwd}`);
        transitions.length = 0;
        baselineCwd = cwd;
        return;
      }
      marker.onDispose(() => {
        const idx = transitions.findIndex((t) => t.marker === marker);
        if (idx === -1) return;
        // 最古（trim）の dispose のみ baseline へ昇格する。reflow 由来の中間 dispose で
        // 昇格すると、生存中のより古い遷移を破棄して baseline を汚染するため 1 件除去に留める
        const [removed] = transitions.splice(idx, 1);
        if (idx === 0 && removed !== undefined) {
          baselineCwd = removed.cwd;
        }
      });
      transitions.push({ marker, cwd });
    },
    cwdAtLine(bufferLine) {
      // 末尾から線形探索: hover はバッファ末尾付近が支配的で、遷移数は cd 回数程度
      for (let i = transitions.length - 1; i >= 0; i--) {
        const t = transitions[i];
        if (t !== undefined && t.marker.line <= bufferLine) return t.cwd;
      }
      return baselineCwd;
    },
  };
}
