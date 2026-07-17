// 絶対パスの単一ファイル watch registry。
//
// preview が表示中の worktree 外ファイル（設定 JSON / session log 等）は fsWatchRegistry
// （worktree スコープの再帰 watch）の対象外で、fsChange が届かない。renderer が表示中の
// ファイルだけを明示的に watch 要求し、変更を `fsChangeAbsolute { path }` として push する
// （VS Code が開いているファイルを個別 watch するのと同じ形）。
//
// - path ごとに refcount で共有する（本体 preview と複数の pinned window が同じファイルを
//   見るケース）。unwatch で 0 になったら watcher を破棄する
// - ファイル自体ではなく親 dir を非再帰 watch し basename で filter する。atomic write
//   （tmp + rename）で inode が入れ替わっても検知を切らさないため
// - fsWatchRegistry（@parcel/watcher + utilityProcess 隔離）を使わないのは、あちらが
//   再帰 watch + glob 除外のための重装備だから。単一ファイルは node:fs.watch で足りる

import { tryCatch } from "@gozd/shared";
import { watch } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { PushFn } from "../rpcDispatcher";

/** rename + change の連続発火（atomic write は 2 イベント届く）を 1 回の push にまとめる */
const DEBOUNCE_MS = 100;

interface AbsFileWatchEntry {
  refCount: number;
  /** watcher close + debounce timer clear をまとめた破棄関数 */
  dispose: () => void;
}

const entries = new Map<string, AbsFileWatchEntry>();

/** push は「最後に watch を要求した renderer」に束縛する（fsWatchRegistry の fsPush と同じ流儀。
 * renderer 再構築時は mount 時の watch 要求で貼り直される） */
let pushFn: PushFn | undefined;

export function watchAbsFile(path: string, push: PushFn): void {
  if (!isAbsolute(path)) throw new Error(`notAbsolutePath: ${path}`);
  pushFn = push;
  const existing = entries.get(path);
  if (existing !== undefined) {
    existing.refCount++;
    return;
  }
  const fileName = basename(path);
  let debounceTimer: NodeJS.Timeout | undefined;
  const started = tryCatch(() =>
    watch(dirname(path), { recursive: false }, (_eventType, filename) => {
      if (filename !== fileName) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (pushFn === undefined) {
          console.error(`[absFileWatcher] push unbound, event dropped: ${path}`);
          return;
        }
        pushFn("fsChangeAbsolute", { path });
      }, DEBOUNCE_MS);
    }),
  );
  // watch 失敗（親 dir 消失等）はエラーで renderer に返す（fallback せずエラーにする）
  if (!started.ok) throw started.error;
  const watcher = started.value;
  entries.set(path, {
    refCount: 1,
    dispose: () => {
      clearTimeout(debounceTimer);
      watcher.close();
    },
  });
}

export function unwatchAbsFile(path: string): void {
  const entry = entries.get(path);
  if (entry === undefined) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  entry.dispose();
  entries.delete(path);
}

/** アプリ終了時の一括破棄 */
export function unwatchAllAbsFiles(): void {
  for (const entry of entries.values()) entry.dispose();
  entries.clear();
}
