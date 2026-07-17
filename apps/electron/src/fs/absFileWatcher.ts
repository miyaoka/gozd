// 絶対パスの単一ファイル watch registry。
//
// preview が表示中の worktree 外ファイル（設定 JSON / session log 等）は fsWatchRegistry
// （worktree スコープの再帰 watch）の対象外で、fsChange が届かない。renderer が表示中の
// ファイルだけを明示的に watch 要求し、変更を `fsChangeAbsolute { path }` として push する
// （VS Code が開いているファイルを個別 watch するのと同じ形）。
//
// - path ごとに refcount で共有する（本体 preview と複数の pinned window が同じファイルを
//   見るケース）。unwatch で 0 になったら watcher を破棄する
// - fsWatchRegistry（@parcel/watcher + utilityProcess 隔離）を使わないのは、あちらが
//   再帰 watch + glob 除外のための重装備だから。単一ファイルは node:fs.watch で足りる

import { tryCatch } from "@gozd/shared";
import { statSync, watch } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { PushFn } from "../rpcDispatcher";

/** イベントの連続発火（atomic write は tmp 書き込み + rename の 2 イベント届く）を
 * 1 回の変更判定にまとめる */
const DEBOUNCE_MS = 100;

/** 変更判定に使うファイル署名。atomic write（rename）は ino が、直接上書きは mtime / size が
 * 動く。不在（削除・未作成）は undefined で表現する */
interface FileSig {
  ino: number;
  mtimeMs: number;
  size: number;
}

function fileSig(path: string): FileSig | undefined {
  const stat = tryCatch(() => statSync(path));
  if (!stat.ok) return undefined;
  return { ino: stat.value.ino, mtimeMs: stat.value.mtimeMs, size: stat.value.size };
}

function sigEquals(a: FileSig | undefined, b: FileSig | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * 単一ファイルの変更検知を張る低レベル helper（appConfigWatcher と registry で共有）。
 * 戻り値は dispose。watch を張れない（非絶対パス / 親 dir 不在）場合は throw する。
 *
 * ファイル自体ではなく親 dir を非再帰 watch し、debounce 後に対象ファイルの stat
 * （ino / mtime / size）を前回と比較して変更を判定する。イベントの filename を使わないのは、
 * atomic write（tmp + rename）の rename イベントが tmp 側の名前で届く・無関係ファイルの
 * 書き込みで対象名の spurious イベントが届く、などランタイム（bun / node）とエディタの
 * 書き込み手順に依存して信頼できないため。stat 比較なら書き込み手順を問わず正しく判定でき、
 * inode の入れ替わりでも検知が途切れない。
 *
 * FSWatcher は EventEmitter で、監視中 dir の削除等で非同期に 'error' を emit する。
 * リスナー無しだと uncaught exception で main プロセスごと落ちるため、watcher を畳んでから
 * onError に通知する。
 */
export function watchSingleFile(
  path: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): () => void {
  if (!isAbsolute(path)) throw new Error(`notAbsolutePath: ${path}`);
  let lastSig = fileSig(path);
  let debounceTimer: NodeJS.Timeout | undefined;
  const started = tryCatch(() =>
    watch(dirname(path), { recursive: false }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        const sig = fileSig(path);
        if (sigEquals(sig, lastSig)) return;
        lastSig = sig;
        onChange();
      }, DEBOUNCE_MS);
    }),
  );
  if (!started.ok) throw started.error;
  const watcher = started.value;
  const dispose = () => {
    clearTimeout(debounceTimer);
    watcher.close();
  };
  watcher.on("error", (error) => {
    dispose();
    onError(error);
  });
  return dispose;
}

interface AbsFileWatchEntry {
  refCount: number;
  dispose: () => void;
}

const entries = new Map<string, AbsFileWatchEntry>();

/** push は「最後に watch を要求した renderer」に束縛する（fsWatchRegistry の fsPush と同じ流儀。
 * renderer 再構築時は mount 時の watch 要求で貼り直される） */
let pushFn: PushFn | undefined;

export function watchAbsFile(path: string, push: PushFn): void {
  pushFn = push;
  const existing = entries.get(path);
  if (existing !== undefined) {
    existing.refCount++;
    return;
  }
  // watch 失敗（非絶対パス / 親 dir 消失等）はエラーで renderer に返す（fallback せずエラーにする）
  const dispose = watchSingleFile(
    path,
    () => {
      if (pushFn === undefined) {
        console.error(`[absFileWatcher] push unbound, event dropped: ${path}`);
        return;
      }
      pushFn("fsChangeAbsolute", { path });
    },
    (error) => {
      // 非同期 error は entry ごと破棄する（refCount は無視して即死。以後の unwatch は no-op で安全）
      console.error(`[absFileWatcher] watcher error, watch dropped: ${path}: ${error}`);
      entries.delete(path);
    },
  );
  entries.set(path, { refCount: 1, dispose });
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
