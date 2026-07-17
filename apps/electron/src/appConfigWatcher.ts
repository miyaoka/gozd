// AppConfig ファイル（~/.config/gozd/config.json）の変更検知と hot reload push。
//
// 設定の SSOT はファイル。settings UI の保存も preview / 外部エディタでの直接編集も
// 同じファイルに合流するため、ファイル変更を `appConfigChange { config }` として push すれば
// どの書き込み経路でも renderer への反映（theme / フォント / voicevox）が揃う
// （VS Code の settings.json hot reload と同型）。
//
// preview の表示内容の追従は本 watcher の責務ではない: 表示中ファイルの再取得は
// absFileWatcher（renderer が表示中の絶対パスを個別 watch → `fsChangeAbsolute`）が担う。
// 変更検知の実体（親 dir 非再帰 watch + stat 比較 + debounce + error ハンドリング）は
// 同モジュールの `watchSingleFile` を共有する。

import { tryCatch } from "@gozd/shared";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { watchSingleFile } from "./fs/absFileWatcher";
import type { PushFn } from "./rpcDispatcher";
import { appConfigPath, loadAppConfig } from "./stores";

let disposeWatch: (() => void) | undefined;

export function startAppConfigWatcher(push: PushFn): void {
  // 初回起動（config 未保存）でも watch を張れるよう dir を作っておく
  mkdirSync(dirname(appConfigPath), { recursive: true });
  const started = tryCatch(() =>
    watchSingleFile(
      appConfigPath,
      () => {
        const loaded = tryCatch(() => loadAppConfig());
        if (!loaded.ok) {
          // 手編集途中の不正 JSON 等。壊れた設定は適用させない（push しない）。
          // 正しい内容で保存し直されれば次のイベントで再送される
          console.error(`[appConfigWatcher] load failed, push skipped: ${loaded.error}`);
          return;
        }
        push("appConfigChange", { config: loaded.value });
      },
      (error) => {
        // 非同期 error（config dir の削除等）。watcher は watchSingleFile 側で畳み済み
        console.error(`[appConfigWatcher] watcher error, hot reload stopped: ${error}`);
        disposeWatch = undefined;
      },
    ),
  );
  if (!started.ok) {
    // watch が張れなくても起動は止めない（hot reload が効かないだけ。UI 経由の適用は生きる）
    console.error(`[appConfigWatcher] watch failed: ${started.error}`);
    return;
  }
  disposeWatch = started.value;
}

export function stopAppConfigWatcher(): void {
  disposeWatch?.();
  disposeWatch = undefined;
}
