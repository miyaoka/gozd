/**
 * テーマ選択コマンド。
 * コマンドパレットから "Terminal: Select Theme" を実行すると QuickPick が開き、
 * テーマ名のフォーカスでリアルタイムプレビュー、Enter で確定保存、Escape でロールバックする。
 */

import type { AppConfig } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { darkThemeNames, lightThemeNames, loadTheme } from "@gozd/themes";
import { useCommandRegistry } from "../../shared/command";
import { useQuickPick } from "../palette";
import type { QuickPickItem } from "../palette";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "../preview";
import { rpcLoadAppConfig, rpcSaveAppConfig } from "../settings";
import {
  currentTheme,
  currentThemeName,
  getDefaultTheme,
  terminalFontFamily,
  terminalFontSize,
} from "./terminalConfig";

/**
 * テーマ適用の世代トークン。
 * 起動時復元と QuickPick の両方で共有し、後から来たリクエストが
 * 先行リクエストの結果を破棄できるようにする。
 */
let generation = 0;

/**
 * テーマ名を指定してターミナルテーマを適用する。
 * 空文字列の場合はデフォルトテーマに戻す。
 * 設定モーダル等、外部からテーマを変更する場合に使用する。
 */
export async function applyTerminalTheme(themeName: string): Promise<void> {
  const gen = ++generation;
  if (themeName === "") {
    currentTheme.value = getDefaultTheme();
    currentThemeName.value = undefined;
    return;
  }
  const theme = await loadTheme(themeName);
  if (gen !== generation) return;
  if (theme !== undefined) {
    currentTheme.value = theme;
    currentThemeName.value = themeName;
  }
}

/** 起動時に保存済み設定を復元する */
async function restoreSavedConfig(): Promise<void> {
  const gen = ++generation;
  const result = await tryCatch(rpcLoadAppConfig());
  if (gen !== generation) return;
  if (!result.ok) return;
  const config = result.value.config;
  if (config === undefined) return;

  // テーマ復元（空文字列は未設定 = デフォルト維持）
  const themeName = config.terminal?.theme ?? "";
  if (themeName !== "") {
    const theme = await loadTheme(themeName);
    if (gen !== generation) return;
    if (theme !== undefined) {
      currentTheme.value = theme;
      currentThemeName.value = themeName;
    }
  }

  // ターミナルフォント復元（空文字列 / 0 は未設定 = ストア初期値維持）
  if (config.terminal !== undefined) {
    if (config.terminal.fontFamily !== "") {
      terminalFontFamily.value = config.terminal.fontFamily;
    }
    if (config.terminal.fontSize > 0) {
      terminalFontSize.value = config.terminal.fontSize;
    }
  }

  // プレビューフォント復元
  if (config.preview !== undefined) {
    if (config.preview.fontFamily !== "") {
      previewFontFamily.value = config.preview.fontFamily;
    }
    if (config.preview.fontSize > 0) {
      previewFontSize.value = config.preview.fontSize;
    }
    if (config.preview.codeFontFamily !== "") {
      previewCodeFontFamily.value = config.preview.codeFontFamily;
    }
  }
}

/** terminal.theme を更新する。proto3 message のため load → mutate → save の RMW で行う */
async function saveTerminalTheme(themeName: string): Promise<void> {
  const loadResult = await tryCatch(rpcLoadAppConfig());
  if (!loadResult.ok) return;
  const config: AppConfig = loadResult.value.config ?? {
    terminal: undefined,
    preview: undefined,
    voicevox: undefined,
    arcade: undefined,
  };
  config.terminal = {
    theme: themeName,
    fontFamily: config.terminal?.fontFamily ?? "",
    fontSize: config.terminal?.fontSize ?? 0,
  };
  await rpcSaveAppConfig(config);
}

export function registerThemeCommand(): () => void {
  const registry = useCommandRegistry();
  const { show } = useQuickPick();

  /* design token から default theme を seed (CSS は app mount 時点で確実に load 済み)。
   * 保存済み theme があれば restoreSavedConfig が上書きする */
  currentTheme.value = getDefaultTheme();

  // 起動時に保存済み設定を復元
  void restoreSavedConfig();

  const dispose = registry.register("terminal.selectTheme", {
    label: "Terminal: Select Theme",
    handler: () => {
      // QuickPick を開いた時点で起動時復元を含む先行リクエストを失効させる
      generation++;
      const previousTheme = { ...currentTheme.value };

      const items: QuickPickItem[] = [
        { label: "Dark", separator: true },
        ...darkThemeNames.map((name) => ({ label: name })),
        { label: "Light", separator: true },
        ...lightThemeNames.map((name) => ({ label: name })),
      ];

      const activeIndex =
        currentThemeName.value !== undefined
          ? items.findIndex((item) => item.label === currentThemeName.value)
          : undefined;

      show({
        items,
        placeholder: "Select a terminal theme...",
        activeIndex: activeIndex !== -1 ? activeIndex : undefined,
        onHighlight: (item) => {
          const gen = ++generation;
          void loadTheme(item.label).then((theme) => {
            if (gen !== generation) return;
            if (theme !== undefined) {
              currentTheme.value = theme;
            }
          });
        },
        onAccept: (item) => {
          const gen = ++generation;
          void loadTheme(item.label).then((theme) => {
            if (gen !== generation) return;
            if (theme !== undefined) {
              currentTheme.value = theme;
              currentThemeName.value = item.label;
              void saveTerminalTheme(item.label);
            }
          });
        },
        onCancel: () => {
          generation++;
          currentTheme.value = previousTheme;
        },
      });

      return true;
    },
  });

  return dispose;
}
