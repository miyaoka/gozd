// AppConfig ファイル（~/.config/gozd/config.json）の変更検知と hot reload push。
//
// 設定の SSOT はファイル。settings UI の保存も preview / 外部エディタでの直接編集も
// 同じファイルに合流するため、ファイル変更を `appConfigChange { config }` として push すれば
// どの書き込み経路でも renderer への反映（theme / フォント / voicevox）が揃う
// （VS Code の settings.json hot reload と同型）。
//
// preview の表示内容の追従は本 watcher の責務ではない: 表示中ファイルの再取得は
// absFileWatcher（renderer が表示中の絶対パスを個別 watch → `fsChangeAbsolute`）が担う。
//
// fsWatchRegistry（@parcel/watcher + utilityProcess 隔離）を使わないのは、あちらが
// worktree スコープの再帰 watch + glob 除外のための重装備だから。単一ファイルの変更検知は
// node:fs.watch（親 dir の非再帰 watch）で足りる。ファイル自体ではなく親 dir を watch
// するのは、writeFileAtomic の tmp + rename で inode が入れ替わっても検知が途切れない
// ようにするため（rename イベントは config.json の filename で届く）。

import { tryCatch } from "@gozd/shared";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { PushFn } from "./rpcDispatcher";
import { appConfigPath, loadAppConfig } from "./stores";

/** rename + change の連続発火（atomic write は 2 イベント届く）を 1 回の push にまとめる */
const DEBOUNCE_MS = 100;

let watcher: FSWatcher | undefined;
let debounceTimer: NodeJS.Timeout | undefined;

export function startAppConfigWatcher(push: PushFn): void {
  const configDir = dirname(appConfigPath);
  const configFileName = basename(appConfigPath);
  // 初回起動（config 未保存）でも watch を張れるよう dir を作っておく
  mkdirSync(configDir, { recursive: true });
  const started = tryCatch(() =>
    watch(configDir, { recursive: false }, (_eventType, filename) => {
      if (filename !== configFileName) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const loaded = tryCatch(() => loadAppConfig());
        if (!loaded.ok) {
          // 手編集途中の不正 JSON 等。壊れた設定は適用させない（push しない）。
          // 正しい内容で保存し直されれば次のイベントで再送される
          console.error(`[appConfigWatcher] load failed, push skipped: ${loaded.error}`);
          return;
        }
        push("appConfigChange", { config: loaded.value });
      }, DEBOUNCE_MS);
    }),
  );
  if (!started.ok) {
    // watch が張れなくても起動は止めない（hot reload が効かないだけ。UI 経由の適用は生きる）
    console.error(`[appConfigWatcher] watch failed: ${started.error}`);
    return;
  }
  watcher = started.value;
}

export function stopAppConfigWatcher(): void {
  clearTimeout(debounceTimer);
  watcher?.close();
  watcher = undefined;
}
