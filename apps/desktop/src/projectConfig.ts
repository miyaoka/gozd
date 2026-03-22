/**
 * プロジェクト設定モジュール
 *
 * プロジェクト固有の設定を ~/.config/gozd/projects/<projectKey>/config.json に永続化する。
 * 操作の都度即時保存する。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@gozd/shared";
import type { ProjectConfig } from "@gozd/rpc";
import { projectKey } from "./projectKey";

const PROJECTS_DIR = path.join(homedir(), ".config", "gozd", "projects");
const CONFIG_FILE = "config.json";

/** プロジェクト固有のデータディレクトリパスを返す */
function getProjectDir(projectDir: string): string {
  return path.join(PROJECTS_DIR, projectKey(projectDir));
}

function getConfigPath(projectDir: string): string {
  return path.join(getProjectDir(projectDir), CONFIG_FILE);
}

function ensureProjectDir(projectDir: string): void {
  const dir = getProjectDir(projectDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** プロジェクト設定を読み込む（ファイル未作成や不正な場合は空オブジェクト） */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const content = tryCatch(() => fs.readFileSync(getConfigPath(projectDir), "utf-8"));
  if (!content.ok) {
    if ((content.error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw content.error;
  }
  const parsed = tryCatch(() => JSON.parse(content.value) as unknown);
  if (!parsed.ok) return {};
  if (typeof parsed.value !== "object" || parsed.value === null) return {};
  return parsed.value as ProjectConfig;
}

/** プロジェクト設定を保存する（read-modify-write: 既存キーを保持しつつ渡されたキーをマージする） */
export function saveProjectConfig(projectDir: string, patch: ProjectConfig): void {
  ensureProjectDir(projectDir);
  const current = loadProjectConfig(projectDir);
  const merged = { ...current, ...patch };
  fs.writeFileSync(getConfigPath(projectDir), JSON.stringify(merged, null, 2));
}
