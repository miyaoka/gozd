// Window frame の保存・復元。Swift shell は SwiftUI Window scene の macOS 標準
// window restoration に任せており対応コードを持たない（proto AppState.window_frame も
// produce/consume 経路の無い dead field として削除済み）。Electron は自動復元機構を
// 持たないため、shell 固有 state として自前で永続化する。
//
// 保存先は共有の app-state.json ではなく専用ファイル `electron-window.json`:
// - proto AppState に window_frame を復活させると Swift shell と schema を再共有する
//   ことになり、Swift 側の macOS 標準復元と二重管理の競合を生む
// - frame は Electron shell だけの関心事なので proto を触らず shell-local に閉じる
//
// dev / stable の区別はしない（永続データは channel 共有の方針。architecture.md）。
// 保存タイミングは window "close"（destroy 前に getNormalBounds を取れる最後の同期点。
// will-quit 時点では window が既に destroy されているため使えない）。

import { tryCatch } from "@gozd/shared";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./stores";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 永続 JSON から bounds を検証つきで取り出す。形が壊れていたら undefined */
function parseBounds(value: unknown): WindowBounds | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const { x, y, width, height } = record;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

export function createWindowStateStore(stateDir: string) {
  const filePath = join(stateDir, "electron-window.json");

  function loadBounds(): WindowBounds | undefined {
    if (!existsSync(filePath)) return undefined;
    const result = tryCatch(() => JSON.parse(readFileSync(filePath, "utf8")) as unknown);
    if (!result.ok) {
      // 永続データポリシー（後方互換を作らない）: parse 失敗は新規初期化が期待挙動。
      // frame はデフォルトサイズ起動に倒すだけで主データを巻き込まないため
      // 上書き save はせず、次回 close 時の save で自然に再生成させる
      console.error(`[WindowStateStore] parse failed, fallback to default bounds: ${result.error}`);
      return undefined;
    }
    if (result.value === null || typeof result.value !== "object") return undefined;
    return parseBounds((result.value as Record<string, unknown>).bounds);
  }

  function saveBounds(bounds: WindowBounds): void {
    writeFileAtomic(filePath, JSON.stringify({ bounds }, null, 2));
  }

  return { loadBounds, saveBounds };
}

export const windowStateStore = createWindowStateStore(
  join(homedir(), ".local", "state", "gozd"),
);
