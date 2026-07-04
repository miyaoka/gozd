/**
 * main ↔ preload ↔ renderer で共有する IPC 契約。
 * proto SSOT の代替: 単一 TS 型を三者が import することで型共有が完結する（issue #895 の中核検証項目）
 */

export interface PtySpawnParams {
  cols: number;
  rows: number;
}

/** preload が contextBridge で renderer に公開する API */
export interface SpikeApi {
  /** PTY を spawn し ptyId を返す */
  ptySpawn: (params: PtySpawnParams) => Promise<number>;
  ptyWrite: (id: number, data: string) => void;
  ptyResize: (id: number, cols: number, rows: number) => void;
  onPtyData: (cb: (id: number, data: string) => void) => void;
  onPtyExit: (cb: (id: number, exitCode: number) => void) => void;
  /** spike 自動テストの結果を main に報告する */
  reportSpikeResult: (ok: boolean, detail: string) => void;
  /** GOZD_SPIKE_TEST=1 起動かどうか（additionalArguments 経由で preload が判定） */
  isTestMode: boolean;
}

export const SPIKE_TEST_ARG = "--gozd-spike-test";
