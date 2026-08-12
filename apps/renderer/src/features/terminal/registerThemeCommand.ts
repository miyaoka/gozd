/**
 * テーマ選択コマンド。
 * コマンドパレットから "Terminal: Select Theme" を実行すると QuickPick が開き、
 * テーマ名のフォーカスでリアルタイムプレビュー、Enter で確定保存、Escape でロールバックする。
 */

import { tryCatch } from "@gozd/shared";
import { darkThemeNames, lightThemeNames, loadTheme } from "@gozd/themes";
import { useCommandRegistry } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { updateAppConfig } from "../../shared/rpc";
import { useQuickPick } from "../../shared/ui";
import type { QuickPickItem } from "../../shared/ui";
import { currentTheme, currentThemeName, getDefaultTheme } from "./terminalConfig";

/**
 * テーマ適用の世代トークン。
 * 起動時復元 (useAppConfigSync 経由の applyTerminalTheme) と QuickPick の両方で共有し、
 * 後から来たリクエストが先行リクエストの結果を破棄できるようにする。
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

/** terminal.theme を更新する。直列化キュー (updateAppConfig) 経由で他セクションと競合させない */
async function saveTerminalTheme(themeName: string): Promise<void> {
  const result = await tryCatch(
    updateAppConfig((config) => {
      config.terminal = {
        theme: themeName,
        fontFamily: config.terminal?.fontFamily ?? "",
        fontSize: config.terminal?.fontSize ?? 0,
      };
    }),
  );
  if (!result.ok) useNotificationStore().error("Failed to save theme", result.error);
}

export function registerThemeCommand(): () => void {
  const registry = useCommandRegistry();
  const { show } = useQuickPick();

  /* design token から default theme を seed (CSS は app mount 時点で確実に load 済み)。
   * 保存済み theme があれば useAppConfigSync の起動時復元が applyTerminalTheme で上書きする */
  currentTheme.value = getDefaultTheme();

  const dispose = registry.register("terminal.selectTheme", {
    label: "Terminal: Select Theme",
    handler: () => {
      // QuickPick を開いた時点で in-flight の theme load を失効させる。起動時復元の
      // config load そのものは失効できない（復元は useAppConfigSync 所有で、この世代
      // トークンは applyTerminalTheme 到達後にしか効かない）。起動直後の 1 往復の間に
      // QuickPick を開くと復元がプレビュー中の選択を上書きする稀な競合は許容する
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
