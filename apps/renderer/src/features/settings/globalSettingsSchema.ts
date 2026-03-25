/** グローバル設定（AppConfig）のスキーマ定義 */

import { darkThemeNames, lightThemeNames } from "@gozd/themes";
import type { SettingSection } from "./types";

/** テーマ名の一覧を返す（空文字列 = デフォルト） */
function getThemeOptions(): readonly string[] {
  return ["", ...darkThemeNames, ...lightThemeNames];
}

export const globalSettingsSections: readonly SettingSection[] = [
  {
    title: "Terminal",
    settings: {
      terminalTheme: {
        widget: "enum",
        label: "Theme",
        description: "Color theme for terminal",
        defaultValue: "",
        options: getThemeOptions,
      },
    },
  },
  {
    title: "VOICEVOX",
    settings: {
      "voicevox.enabled": {
        widget: "boolean",
        label: "Enabled",
        description: "Enable VOICEVOX text-to-speech for Claude responses",
        defaultValue: false,
      },
      "voicevox.speedScale": {
        widget: "number",
        label: "Speed",
        defaultValue: 1.5,
        min: 0.5,
        max: 3.0,
        step: 0.1,
      },
      "voicevox.volumeScale": {
        widget: "number",
        label: "Volume",
        defaultValue: 1.0,
        min: 0.0,
        max: 2.0,
        step: 0.1,
      },
    },
  },
];
