/**
 * app config を起動中の UI に適用する同期点。起動時の復元と `appConfigChange` push
 * （config ファイルの変更）の購読が合流するが、適用範囲は文脈で異なる:
 *
 * - 起動時復元: 副作用のないセクション（theme / font）のみ。voicevox の起動時復元は
 *   useVoicevoxStore 自身の load が所有する（applyVoicevoxConfig の docstring 参照）
 * - push 適用: 全セクション。ユーザーの編集操作への応答なので副作用（engine 起動）も担う
 *
 * 設定の SSOT はファイル。settings UI の変更（SettingsModal の REACTIVE_SYNC）は応答性の
 * ため変更時に直接適用するが、起動時復元 / preview 編集 / 外部エディタでの直接編集は
 * ここが拾って同じ適用に合流させる（VS Code の settings.json hot reload と同型）。
 *
 * UI 保存由来の自己エコー push もここに届くが、適用は「同値なら no-op」の冪等な操作だけで
 * 構成する（ref の同値代入は watch を発火させない）。voicevox store は値変化で configSave を
 * 発火する watch を持つため、この性質がエコーループの収束条件になっている。
 */
import type { AppConfig, AppConfigChangePayload } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { onMessage, rpcLoadAppConfig } from "../../shared/rpc";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "../preview";
import {
  applyTerminalTheme,
  currentThemeName,
  terminalFontFamily,
  terminalFontSize,
} from "../terminal";
import { useVoicevoxStore } from "../voicevox";

/**
 * 副作用のないセクション（theme / font）の適用。ref への冪等な代入だけで構成されるため、
 * 起動時復元と push 適用の両方から同じ関数を使える。
 */
function applyDisplayConfig(config: AppConfig): void {
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
}

/**
 * voicevox セクションの適用。enabled が engine 起動 / 停止の副作用（activate のポーリング待機と
 * 失敗 toast）を伴うため、**ユーザーの編集操作への応答である push 適用からだけ**呼ぶ。
 * 起動時の voicevox 復元は useVoicevoxStore 自身の load が所有する（ユーザーが操作していない
 * 起動時は待機も失敗通知もせず、engine 起動を発火するだけの軽量経路。speak() の fetch 失敗で
 * 自然にスキップされる）。起動時復元をここに合流させると、その軽量経路の設計が壊れる。
 */
function applyVoicevoxConfig(config: AppConfig): void {
  // voicevox: 0 は default 充填由来の「未設定」なので現在値を維持（store 起動時 load と同じ guard）
  const voicevoxStore = useVoicevoxStore();
  if (config.voicevox.speedScale > 0) voicevoxStore.speedScale = config.voicevox.speedScale;
  if (config.voicevox.volumeScale > 0) voicevoxStore.volumeScale = config.voicevox.volumeScale;
  // speakerId も適用する。適用しないと、他 voicevox フィールドとの同時ファイル編集時に
  // store の save watch (echo save) が store 側の旧 speakerId を書き戻し、ファイルの変更を
  // silent に revert してしまう。undefined は「未設定」(キー不在) なので現在値を維持
  if (config.voicevox.speakerId !== undefined) {
    voicevoxStore.setSpeakerId(config.voicevox.speakerId);
  }
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

/** 起動時に保存済み設定を読み、副作用のないセクションだけを push と同じ適用関数へ流す */
async function restoreSavedConfig(isSuperseded: () => boolean): Promise<void> {
  const result = await tryCatch(rpcLoadAppConfig());
  if (!result.ok) {
    useNotificationStore().error("Failed to load app config", result.error);
    return;
  }
  // load 応答前に push が届いた場合、その config の方が新しい。古い load 結果を適用すると
  // push で適用済みの表示設定が古い値に戻り、次の push まで UI がファイルの内容とずれる
  if (isSuperseded()) return;
  if (result.value.config === undefined) return;
  applyDisplayConfig(result.value.config);
}

/** 起動時復元 + 購読登録。MainLayout で一度だけ呼び出す。戻り値は disposer */
export function registerAppConfigSync(): () => void {
  // push 購読を復元より先に確立する（docs/architecture.md の push 購読の規律）。
  // superseded は「この登録の起動時 load が push に追い越された」の 1 回分の状態なので、
  // module スコープに置かず登録のスコープに閉じる
  let superseded = false;
  const dispose = onMessage<AppConfigChangePayload>("appConfigChange", ({ config }) => {
    superseded = true;
    applyDisplayConfig(config);
    applyVoicevoxConfig(config);
  });
  void restoreSavedConfig(() => superseded);
  return dispose;
}
