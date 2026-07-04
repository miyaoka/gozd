// gozd 実行時リソースのパス解決と PTY 環境変数の構築。
// Swift 版 `AppRuntime.defaultSocketPath / claudeSettingsPath / makeEnvOverlay` +
// `Shell/GozdEnvOverlay.swift` の対応物。
//
// channel: Electron shell は現状未パッケージの開発形態のみなので "electron-dev" 固定。
// Swift dev（"dev"）/ stable（"stable"）と socket / settings を分離し、両シェルの
// 同時起動で衝突しない。Swift 撤廃時に "dev"/"stable" を引き継ぐ。
//
// CLI / zsh init は Swift 側の成果物をそのまま参照する:
//   - gozd-cli: ワイヤが proto3 JSON NDJSON で共通のため Swift バイナリを流用できる
//     （`swift build --product gozd-cli` 済みであること。無ければ hook の CLI 経路が
//     command not found で silent 死するが、nc 直送経路は生きる）
//   - zsh init チェーン: 環境変数駆動の shell script なのでシェル実装非依存

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHANNEL = "electron-dev";

const repoRoot = resolve(__dirname, "..", "..", "..");

export const socketPath = join(tmpdir(), `gozd-${CHANNEL}.sock`);
export const claudeSettingsPath = join(tmpdir(), `gozd-${CHANNEL}-claude-settings.json`);
export const cliPath = join(repoRoot, "apps", "native", ".build", "debug", "gozd-cli");
export const zdotdir = join(repoRoot, "apps", "native", "Resources", "zsh");

/** PTY 子プロセスに継承させない親プロセス由来のキー。
 * gozd app が内部フラグとして持つ env を子に漏らさない（Swift strippedKeys と同集合 +
 * Electron 固有の GOZD_ELECTRON_RENDERER_URL） */
const STRIPPED_KEYS = ["GOZD_DEV_PROJECT_ROOT", "GOZD_DEV_VITE_PORT", "GOZD_ELECTRON_RENDERER_URL", "ZDOTDIR"];

/** 親プロセス env を base に renderer env と gozd overlay を重ねた最終形を返す。
 * 優先順（後勝ち）: 親 env → renderer env → gozd overlay。
 * allow-list 継承ではなく全継承 + deny-list（GozdEnvOverlay.swift の設計判断を踏襲） */
export function buildPtyEnv(rendererEnv: Record<string, string>, ptyId: number): Record<string, string> {
  const userHome = homedir();

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  for (const key of STRIPPED_KEYS) {
    delete result[key];
  }

  Object.assign(result, rendererEnv);

  result.GOZD_PTY_ID = String(ptyId);
  result.GOZD_SOCKET_PATH = socketPath;
  result.GOZD_CLI_PATH = cliPath;
  result.GOZD_CLAUDE_SETTINGS_PATH = claudeSettingsPath;

  // ZDOTDIR チェーン: 元値（親 or renderer 指定）を退避してから gozd 側に切替
  const originalZdotdir = rendererEnv.ZDOTDIR ?? process.env.ZDOTDIR ?? userHome;
  result.GOZD_ORIG_ZDOTDIR = originalZdotdir;
  result.GOZD_ZDOTDIR = zdotdir;
  result.ZDOTDIR = zdotdir;

  // 親 / renderer に値があればそちら優先、無ければ gozd デフォルト
  if (result.TERM_PROGRAM === undefined) result.TERM_PROGRAM = "gozd";
  if (result.FORCE_HYPERLINK === undefined) result.FORCE_HYPERLINK = "1";
  if (result.HOME === undefined) result.HOME = userHome;

  return result;
}
