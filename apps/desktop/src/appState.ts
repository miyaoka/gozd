/**
 * アプリ状態の永続化モジュール
 *
 * 最後に開いていたプロジェクトとウィンドウフレーム（位置・サイズ）を
 * ~/.config/orkis/app-state.json に保存し、次回起動時に復元する。
 *
 * 永続化は before-quit（アプリ終了時）の一括コミットのみ。
 * ランタイム中の差分更新は index.ts 側の live 状態（Map）で管理する。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@orkis/shared";

const CONFIG_DIR = path.join(homedir(), ".config", "orkis");
const STATE_FILE = path.join(CONFIG_DIR, "app-state.json");

interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowState {
  /** プロジェクトディレクトリ（git repo の場合は main worktree のルート） */
  dir: string;
  /** 最後にアクティブだった worktree ディレクトリ */
  activeDir: string;
  /** ウィンドウのフレーム（位置・サイズ） */
  frame: WindowFrame;
}

interface AppState {
  windows: WindowState[];
}

const DEFAULT_FRAME: WindowFrame = { width: 1200, height: 800, x: 100, y: 100 };

/** 設定ディレクトリを作成（存在しなければ） */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function isValidFrame(v: unknown): v is WindowFrame {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.x === "number" &&
    typeof f.y === "number" &&
    typeof f.width === "number" &&
    typeof f.height === "number"
  );
}

function isValidWindowState(v: unknown): v is WindowState {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  return typeof w.dir === "string" && typeof w.activeDir === "string" && isValidFrame(w.frame);
}

/** 保存済みの状態を読み込む（不正なエントリは除外する） */
export function loadAppState(): AppState {
  const content = tryCatch(() => fs.readFileSync(STATE_FILE, "utf-8"));
  if (!content.ok) return { windows: [] };
  const parsed = tryCatch(() => JSON.parse(content.value) as unknown);
  if (!parsed.ok) return { windows: [] };
  const raw = parsed.value;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).windows)
  ) {
    return { windows: [] };
  }
  const windows = ((raw as Record<string, unknown>).windows as unknown[]).filter(
    isValidWindowState,
  );
  return { windows };
}

/** snapshot を受け取って即時保存する（アプリ終了時の唯一のコミット点） */
export function saveSnapshot(windows: WindowState[]): void {
  ensureConfigDir();
  const state: AppState = { windows };
  const result = tryCatch(() => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)));
  if (!result.ok) {
    console.error(`[app-state] save failed: ${result.error.message}`);
  }
}

/** デフォルトのフレーム値 */
export function getDefaultFrame(): WindowFrame {
  return { ...DEFAULT_FRAME };
}

export type { WindowFrame, WindowState, AppState };
