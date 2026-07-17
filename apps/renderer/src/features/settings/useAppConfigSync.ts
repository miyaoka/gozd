/**
 * `appConfigChange` push（config ファイルの変更）を購読して起動中の UI に適用する。
 *
 * 設定の SSOT はファイル。settings UI の変更（SettingsModal の REACTIVE_SYNC）は応答性の
 * ため変更時に直接適用するが、preview 編集 / 外部エディタでの直接編集はこの購読が拾って
 * 同じ適用に合流させる（VS Code の settings.json hot reload と同型）。
 *
 * UI 保存由来の自己エコー push もここに届くが、適用は「同値なら no-op」の冪等な操作だけで
 * 構成する（ref の同値代入は watch を発火させない）。voicevox store は値変化で configSave を
 * 発火する watch を持つため、この性質がエコーループの収束条件になっている。
 */
import type { AppConfig } from "@gozd/rpc";
import { onMessage } from "../../shared/rpc";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "../preview";
import {
  applyTerminalTheme,
  currentThemeName,
  terminalFontFamily,
  terminalFontSize,
} from "../terminal";
import { useVoicevoxStore } from "../voicevox";

interface AppConfigChangePayload {
  config: AppConfig;
}

function applyConfig(config: AppConfig): void {
  // theme: 適用済みと同名なら再適用しない。applyTerminalTheme は同名でもテーマを load し直して
  // currentTheme の identity を変える（xterm 再適用が走る）ため、無関係なキーの保存エコーで
  // 毎回発火させない。空文字は「未設定 = デフォルトテーマ」（currentThemeName は undefined）
  const themeName = config.terminal.theme;
  if ((themeName === "" ? undefined : themeName) !== currentThemeName.value) {
    void applyTerminalTheme(themeName);
  }

  // font 類: 空文字 / 0 は「未設定 = デフォルト」の schema 契約をそのまま代入する
  // （SettingsModal の REACTIVE_SYNC と同じ意味論）
  terminalFontFamily.value = config.terminal.fontFamily;
  terminalFontSize.value = config.terminal.fontSize;
  previewFontFamily.value = config.preview.fontFamily;
  previewFontSize.value = config.preview.fontSize;
  previewCodeFontFamily.value = config.preview.codeFontFamily;

  // voicevox: 0 は default 充填由来の「未設定」なので現在値を維持（store 起動時 load と同じ guard）
  const voicevoxStore = useVoicevoxStore();
  if (config.voicevox.speedScale > 0) voicevoxStore.speedScale = config.voicevox.speedScale;
  if (config.voicevox.volumeScale > 0) voicevoxStore.volumeScale = config.voicevox.volumeScale;
  // enabled は engine 起動 / 停止の副作用を伴うため、実際に状態が変わるときだけ UI トグルと
  // 同じ activate / deactivate を通す（activate 失敗時は enabled が false のまま → store の
  // save watch が false を書き戻す、まで UI 経由と同じ挙動に揃う）
  if (config.voicevox.enabled !== voicevoxStore.enabled) {
    if (config.voicevox.enabled) {
      void voicevoxStore.activate();
    } else {
      voicevoxStore.deactivate();
    }
  }
}

/** 購読登録。MainLayout で一度だけ呼び出す。戻り値は disposer */
export function registerAppConfigSync(): () => void {
  return onMessage<AppConfigChangePayload>("appConfigChange", ({ config }) => {
    applyConfig(config);
  });
}
