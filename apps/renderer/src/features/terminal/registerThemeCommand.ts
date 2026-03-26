/**
 * テーマ選択コマンド。
 * コマンドパレットから "Terminal: Select Theme" を実行すると QuickPick が開き、
 * テーマ名のフォーカスでリアルタイムプレビュー、Enter で確定保存、Escape でロールバックする。
 */

import type { AppConfig } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { darkThemeNames, lightThemeNames, loadTheme } from "@gozd/themes";
import { useCommandRegistry } from "../../shared/command";
import { useRpc } from "../../shared/rpc";
import { useQuickPick } from "../palette";
import type { QuickPickItem } from "../palette";
import { previewFontFamily, previewFontSize } from "../preview";
import { globalSettingsDefaults } from "../settings";
import {
  DEFAULT_THEME,
  currentTheme,
  currentThemeName,
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
    currentTheme.value = DEFAULT_THEME;
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

/** ユーザー設定をスキーマのデフォルト値とマージして返す */
function resolveConfig(userConfig: AppConfig): Record<string, unknown> {
  return { ...globalSettingsDefaults, ...userConfig };
}

/** 起動時に保存済み設定を復元する */
async function restoreSavedConfig(configLoad: () => Promise<AppConfig>): Promise<void> {
  const gen = ++generation;
  const result = await tryCatch(configLoad());
  if (gen !== generation) return;
  if (!result.ok) return;
  const config = resolveConfig(result.value);

  // テーマ復元
  const themeName = config["terminal.theme"];
  if (typeof themeName === "string" && themeName !== "") {
    const theme = await loadTheme(themeName);
    if (gen !== generation) return;
    if (theme !== undefined) {
      currentTheme.value = theme;
      currentThemeName.value = themeName;
    }
  }

  // ターミナルフォント復元
  if (typeof config["terminal.fontFamily"] === "string") {
    terminalFontFamily.value = config["terminal.fontFamily"];
  }
  if (typeof config["terminal.fontSize"] === "number") {
    terminalFontSize.value = config["terminal.fontSize"];
  }

  // プレビューフォント復元
  if (typeof config["preview.fontFamily"] === "string") {
    previewFontFamily.value = config["preview.fontFamily"];
  }
  if (typeof config["preview.fontSize"] === "number") {
    previewFontSize.value = config["preview.fontSize"];
  }
}

export function registerThemeCommand(): () => void {
  const registry = useCommandRegistry();
  const { show } = useQuickPick();
  const { request } = useRpc();

  // 起動時に保存済み設定を復元
  void restoreSavedConfig(() => request.configLoad());

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
              void request.configSave({ "terminal.theme": item.label });
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
