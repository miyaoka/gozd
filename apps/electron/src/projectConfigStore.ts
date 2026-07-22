// プロジェクト固有設定の永続化（`~/.config/gozd/projects/<projectKey>/config.json`）。
// Swift 版 `Store/ProjectConfigStore.swift` の対応物。
//
// - projectKey 解決は taskStore.ts の resolveMainRepoRoot / resolveProjectKey と共有する
//   （main / worktree / subdir のどこから開いても同じ config.json を参照する）
// - load はファイル不在ならデフォルト値。既存ファイルの欠落フィールドは default 充填する
//   （`rawJson.ts` の契約参照）
// - save は message を丸ごと書く。AppConfigStore と同流儀で未知 top-level キーは
//   保持しない（AppStateStore の shallow merge とは対照的）

import type { ProjectConfig } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asDict, lenientString, lenientStringArray } from "./rawJson";
import { resolveProjectKey } from "./taskStore";

const configDir = join(homedir(), ".config", "gozd");

async function configFilePath(dir: string): Promise<string> {
  const projectKey = await resolveProjectKey(dir);
  return join(configDir, "projects", projectKey, "config.json");
}

// ユーザー設定ファイルの lenient ポリシー（rawJson.ts の契約）。型違反フィールドは
// default に倒して stderr ログを残し、ファイルは書き換えない。テスト用に export
export function normalizeProjectConfig(raw: unknown): ProjectConfig {
  const dict = asDict(raw);
  return {
    worktreeSymlinks: lenientStringArray(dict.worktreeSymlinks, "projectConfig.worktreeSymlinks"),
    setupScript: lenientString(dict.setupScript, "projectConfig.setupScript"),
  };
}

export async function loadProjectConfig(dir: string): Promise<ProjectConfig> {
  const path = await configFilePath(dir);
  if (!existsSync(path)) return normalizeProjectConfig({});
  const parsed = tryCatch(() => normalizeProjectConfig(JSON.parse(readFileSync(path, "utf8"))));
  if (parsed.ok) return parsed.value;
  // ユーザー編集ファイルは reinit しない（修復はユーザーの責務）。default で動かしログのみ残す
  console.error(
    `[loadProjectConfig] parse failed at ${path}: ${parsed.error}; using defaults (file left untouched)`,
  );
  return normalizeProjectConfig({});
}

export async function saveProjectConfig(dir: string, config: ProjectConfig): Promise<void> {
  const path = await configFilePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  // Swift 期の `.atomic` write と同じ保証: 同 dir の tmp に書いて rename
  // settings UI の「Open settings file (JSON)」で preview 表示する対象のため整形して書く
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  renameSync(tmpPath, path);
}

/** 設定ファイルを実体化して絶対パスを返す。未存在（一度も保存していないプロジェクト）なら
 * default 充填した現在値を書き出す（VS Code の「Open Settings (JSON)」と同じ挙動）。
 * preview は不在ファイルを "File not found" 表示に倒すため、開く前に実体を保証する。 */
export async function ensureProjectConfigFile(dir: string): Promise<string> {
  const path = await configFilePath(dir);
  if (!existsSync(path)) await saveProjectConfig(dir, await loadProjectConfig(dir));
  return path;
}
