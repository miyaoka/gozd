// プロジェクト固有設定の永続化（`~/.config/gozd/projects/<projectKey>/config.json`）。
// Swift 版 `Store/ProjectConfigStore.swift` の対応物。
//
// - projectKey 解決は taskStore.ts の resolveMainRepoRoot / resolveProjectKey と共有する
//   （main / worktree / subdir のどこから開いても同じ config.json を参照する）
// - load はファイル不在ならデフォルト値。未知フィールドは ts-proto fromJSON が既知
//   フィールドしか読まないため自然に無視される（Swift の ignoreUnknownFields と同挙動）
// - save は proto message を丸ごと書く。AppConfigStore と同流儀で未知 top-level キーは
//   保持しない（AppStateStore の shallow merge とは対照的）

import { ProjectConfig } from "@gozd/proto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProjectKey } from "./taskStore";

const configDir = join(homedir(), ".config", "gozd");

async function configFilePath(dir: string): Promise<string> {
  const projectKey = await resolveProjectKey(dir);
  return join(configDir, "projects", projectKey, "config.json");
}

export async function loadProjectConfig(dir: string): Promise<ProjectConfig> {
  const path = await configFilePath(dir);
  if (!existsSync(path)) return ProjectConfig.fromJSON({});
  return ProjectConfig.fromJSON(JSON.parse(readFileSync(path, "utf8")));
}

export async function saveProjectConfig(dir: string, config: ProjectConfig): Promise<void> {
  const path = await configFilePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  // Swift の `.atomic` write と同じ保証: 同 dir の tmp に書いて rename
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(ProjectConfig.toJSON(config)));
  renameSync(tmpPath, path);
}
