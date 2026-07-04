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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asArray, asDict } from "./rawJson";
import { resolveProjectKey } from "./taskStore";

const configDir = join(homedir(), ".config", "gozd");

async function configFilePath(dir: string): Promise<string> {
  const projectKey = await resolveProjectKey(dir);
  return join(configDir, "projects", projectKey, "config.json");
}

function normalizeProjectConfig(raw: unknown): ProjectConfig {
  return {
    worktreeSymlinks: asArray(asDict(raw).worktreeSymlinks).filter(
      (value): value is string => typeof value === "string",
    ),
  };
}

export async function loadProjectConfig(dir: string): Promise<ProjectConfig> {
  const path = await configFilePath(dir);
  if (!existsSync(path)) return normalizeProjectConfig({});
  return normalizeProjectConfig(JSON.parse(readFileSync(path, "utf8")));
}

export async function saveProjectConfig(dir: string, config: ProjectConfig): Promise<void> {
  const path = await configFilePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  // Swift 期の `.atomic` write と同じ保証: 同 dir の tmp に書いて rename
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(config));
  renameSync(tmpPath, path);
}
