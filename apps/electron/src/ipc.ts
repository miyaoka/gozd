/**
 * main ↔ preload ↔ renderer で共有する IPC 契約。
 *
 * RPC 本経路の契約は `@gozd/shared` の `ElectronRpcBridge`（renderer と共有する SSOT）。
 * ここには spike 自動テスト専用の補助 API のみ残す。
 */

/** preload が contextBridge で renderer に公開する spike テスト補助 API */
export interface SpikeApi {
  /** spike 自動テストの結果を main に報告する */
  reportSpikeResult: (ok: boolean, detail: string) => void;
  /** GOZD_SPIKE_TEST=1 起動かどうか（additionalArguments 経由で preload が判定） */
  isTestMode: boolean;
}

export const SPIKE_TEST_ARG = "--gozd-spike-test";

/** channel（"stable" | "dev"）を main → preload に渡す additionalArguments のプレフィックス。
 * SSOT は gozdEnv.channel。preload が parse して `window.__gozdChannel` として公開する */
export const GOZD_CHANNEL_ARG_PREFIX = "--gozd-channel=";
