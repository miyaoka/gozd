/**
 * アプリ状態の永続化モジュール
 *
 * 最後に開いていたプロジェクトとウィンドウフレーム（位置・サイズ）を
 * ~/.config/orkis/app-state.json に保存し、次回起動時に復元する。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@orkis/shared";

const CONFIG_DIR = path.join(homedir(), ".config", "orkis");
const STATE_FILE = path.join(CONFIG_DIR, "app-state.json");

/** debounce 用タイマー（高頻度な resize/move に対応） */
const SAVE_DEBOUNCE_MS = 500;

interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowState {
  /** プロジェクト（リポジトリルート）ディレクトリ */
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

let currentState: AppState = { windows: [] };
let saveTimer: ReturnType<typeof setTimeout> | undefined;

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
  if (!content.ok) {
    currentState = { windows: [] };
    return currentState;
  }
  const parsed = tryCatch(() => JSON.parse(content.value) as unknown);
  if (!parsed.ok) {
    currentState = { windows: [] };
    return currentState;
  }
  const raw = parsed.value;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).windows)
  ) {
    currentState = { windows: [] };
    return currentState;
  }
  const windows = ((raw as Record<string, unknown>).windows as unknown[]).filter(
    isValidWindowState,
  );
  currentState = { windows };
  return currentState;
}

/** 状態をファイルに保存する（debounce 付き） */
function scheduleSave(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    ensureConfigDir();
    const result = tryCatch(() =>
      fs.writeFileSync(STATE_FILE, JSON.stringify(currentState, null, 2)),
    );
    if (!result.ok) {
      console.error(`[app-state] save failed: ${result.error.message}`);
    }
  }, SAVE_DEBOUNCE_MS);
}

/** 即時保存（アプリ終了時用） */
export function saveAppStateSync(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  ensureConfigDir();
  const result = tryCatch(() =>
    fs.writeFileSync(STATE_FILE, JSON.stringify(currentState, null, 2)),
  );
  if (!result.ok) {
    console.error(`[app-state] save failed: ${result.error.message}`);
  }
}

/** ウィンドウの状態を更新（なければ追加） */
export function updateWindowState(dir: string, activeDir: string, frame: WindowFrame): void {
  const existing = currentState.windows.find((w) => w.dir === dir);
  if (existing) {
    existing.activeDir = activeDir;
    existing.frame = frame;
  } else {
    currentState.windows.push({ dir, activeDir, frame });
  }
  scheduleSave();
}

/** ウィンドウのフレームのみ更新 */
export function updateWindowFrame(dir: string, frame: WindowFrame): void {
  const existing = currentState.windows.find((w) => w.dir === dir);
  if (existing) {
    existing.frame = frame;
    scheduleSave();
  }
}

/** ウィンドウの activeDir のみ更新 */
export function updateWindowActiveDir(dir: string, activeDir: string): void {
  const existing = currentState.windows.find((w) => w.dir === dir);
  if (existing) {
    existing.activeDir = activeDir;
    scheduleSave();
  }
}

/** ウィンドウの状態を削除 */
export function removeWindowState(dir: string): void {
  currentState.windows = currentState.windows.filter((w) => w.dir !== dir);
  scheduleSave();
}

/** 保存済みのウィンドウ状態を取得 */
export function getWindowStates(): WindowState[] {
  return currentState.windows;
}

/** デフォルトのフレーム値 */
export function getDefaultFrame(): WindowFrame {
  return { ...DEFAULT_FRAME };
}

export type { WindowFrame, WindowState, AppState };
