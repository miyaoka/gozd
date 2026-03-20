/**
 * グローバル設定モジュール
 *
 * アプリ全体の設定を ~/.config/orkis/config.json に永続化する。
 * 操作の都度即時保存する。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@orkis/shared";
import type { AppConfig } from "@orkis/rpc";

const CONFIG_DIR = path.join(homedir(), ".config", "orkis");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/** 設定を読み込む（ファイル未作成や不正な場合は空オブジェクト） */
export function loadConfig(): AppConfig {
  const content = tryCatch(() => fs.readFileSync(CONFIG_FILE, "utf-8"));
  if (!content.ok) return {};
  const parsed = tryCatch(() => JSON.parse(content.value) as unknown);
  if (!parsed.ok) return {};
  if (typeof parsed.value !== "object" || parsed.value === null) return {};
  return parsed.value as AppConfig;
}

/** 設定を保存する（read-modify-write: 既存キーを保持しつつ渡されたキーをマージする） */
export function saveConfig(patch: AppConfig): void {
  ensureConfigDir();
  const current = loadConfig();
  const merged = { ...current, ...patch };
  const result = tryCatch(() => fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2)));
  if (!result.ok) {
    console.error(`[config] save failed: ${result.error.message}`);
  }
}
