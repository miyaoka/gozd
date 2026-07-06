// gozd 実行時リソースのパス解決と PTY 環境変数の構築。
// Swift 版 `AppRuntime.defaultSocketPath / claudeSettingsPath / makeEnvOverlay` +
// `Shell/GozdEnvOverlay.swift` の対応物。
//
// channel: packaged `.app` は "stable"、未パッケージ（`electron .`）は "dev"。
// socket / launch dir / claude settings を channel で分離し、dev と stable の
// 同時起動で衝突しない。永続データ（~/.config/gozd/ 等）は channel 非依存の共有。
//
// gozd-cli は TS 再実装（src/cli.ts → dist/cli.cjs。issue #895）。bin/gozd-cli shim が
// dev は node、packaged は ELECTRON_RUN_AS_NODE=1 + 同梱 Electron バイナリで実行する。
// zsh init チェーンは resources/zsh/。packaged はどちらも `.app` 内 Resources/app/
// 配下に同梱される。

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// packaged 判定: Electron main の __dirname（Resources/app/dist）は packaged 時のみ
// process.resourcesPath（Contents/Resources）配下に入る。`app.isPackaged` を使わないのは
// electron import が bun test で成立しないため（resourcesPath は bun では undefined =
// 非 packaged 判定に自然に倒れる）
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
export const isPackaged = resourcesPath !== undefined && __dirname.startsWith(resourcesPath);

export const channel = isPackaged ? "stable" : "dev";

const electronRoot = resolve(__dirname, "..");
// packaged 時の同梱リソース root（Contents/Resources/app）。非 packaged では使わない
const bundledAppRoot = join(resourcesPath ?? "", "app");

export const socketPath = join(tmpdir(), `gozd-${channel}.sock`);
export const claudeSettingsPath = join(tmpdir(), `gozd-${channel}-claude-settings.json`);
// gozd-cli が GOZD_COLD_START 時に書き出す launch request の置き場。channel 名は
// CLI 側が GOZD_SOCKET_PATH のファイル名から導出するため socket と自動で揃う
export const launchRequestDir = join(tmpdir(), `gozd-${channel}-launch`);
export const cliPath = isPackaged
  ? join(bundledAppRoot, "bin", "gozd-cli")
  : join(electronRoot, "bin", "gozd-cli");
export const zdotdir = isPackaged
  ? join(bundledAppRoot, "zsh")
  : join(electronRoot, "resources", "zsh");
// packaged 時に loadFile する renderer（Vite build は base "./" なので file:// で成立する）
export const bundledRendererIndex = join(bundledAppRoot, "views", "main", "index.html");

/** PTY 子プロセスに継承させない親プロセス由来のキー。
 * gozd app が内部フラグとして持つ env を子に漏らさない（Swift strippedKeys と同集合 +
 * Electron 固有の GOZD_ELECTRON_RENDERER_URL） */
const STRIPPED_KEYS = ["GOZD_DEV_PROJECT_ROOT", "GOZD_DEV_VITE_PORT", "GOZD_ELECTRON_RENDERER_URL", "ZDOTDIR"];

/** 親プロセス env から gozd 起源キーを除去した snapshot を返す。
 * PTY spawn（buildPtyEnv）と commandResolver のログインシェル spawn が共有する deny-list の
 * SSOT。特に ZDOTDIR を剥がさないと、子 zsh が gozd の zsh init チェーンに巻き込まれる */
export function sanitizeParentEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  for (const key of STRIPPED_KEYS) {
    delete result[key];
  }
  return result;
}

/** 親プロセス env を base に renderer env と gozd overlay を重ねた最終形を返す。
 * 優先順（後勝ち）: 親 env → renderer env → gozd overlay。
 * allow-list 継承ではなく全継承 + deny-list（GozdEnvOverlay.swift の設計判断を踏襲） */
export function buildPtyEnv(rendererEnv: Record<string, string>, ptyId: number): Record<string, string> {
  const userHome = homedir();

  const result = sanitizeParentEnv();

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
