// AppConfig / AppState の永続化。
//
// - `~/.config/gozd/config.json` / `~/.local/state/gozd/app-state.json` は
//   dev / stable で共有する
// - load はファイル不在ならデフォルト値（初回起動）。既存ファイルの欠落フィールド
//   （旧 proto3 JSON は default 値を省略して書いた）は default 充填し、未知フィールドは
//   spread でそのまま保持する
// - AppState の save は既存ファイルを raw dict として読み shallow merge し、
//   未知 top-level キー（別バージョンが書いたフィールド）を保持する

import type { AppConfig, AppState, SidebarRepo, WorktreeCacheEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asArray, asDict } from "./rawJson";

const appConfigPath = join(homedir(), ".config", "gozd", "config.json");
const appStatePath = join(homedir(), ".local", "state", "gozd", "app-state.json");

/** Swift 期の `.atomic` write と同じ保証: 同 dir の tmp に書いて rename */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

/** キーを再帰的にソートして出力を安定させる（差分レビューしやすい形を保つ） */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function normalizeAppConfig(raw: unknown): AppConfig {
  const dict = asDict(raw);
  return {
    terminal: { theme: "", fontFamily: "", fontSize: 0, ...asDict(dict.terminal) } as AppConfig["terminal"],
    preview: {
      fontFamily: "",
      fontSize: 0,
      codeFontFamily: "",
      ...asDict(dict.preview),
    } as AppConfig["preview"],
    // speakerId / sfxEnabled は「未設定」をキー不在で表現する optional のため default を置かない
    voicevox: {
      enabled: false,
      speedScale: 0,
      volumeScale: 0,
      ...asDict(dict.voicevox),
    } as AppConfig["voicevox"],
    arcade: { ...asDict(dict.arcade) } as AppConfig["arcade"],
  };
}

function normalizeAppState(raw: unknown): AppState {
  const dict = asDict(raw);
  return {
    sidebarRepos: asArray(dict.sidebarRepos).map((repo) => {
      const repoDict = asDict(repo);
      const worktrees = asArray(repoDict.worktrees).map(
        (wt) => ({ path: "", branch: "", isMain: false, ...asDict(wt) }) as WorktreeCacheEntry,
      );
      return {
        rootDir: "",
        repoName: "",
        isGitRepo: false,
        collapsed: false,
        ...repoDict,
        worktrees,
      } as SidebarRepo;
    }),
  };
}

export function loadAppConfig(): AppConfig {
  if (!existsSync(appConfigPath)) return normalizeAppConfig({});
  return normalizeAppConfig(JSON.parse(readFileSync(appConfigPath, "utf8")));
}

export function saveAppConfig(config: AppConfig): void {
  writeFileAtomic(appConfigPath, JSON.stringify(config));
}

export function loadAppState(): AppState {
  if (!existsSync(appStatePath)) return normalizeAppState({});
  return normalizeAppState(JSON.parse(readFileSync(appStatePath, "utf8")));
}

export function saveAppState(state: AppState): void {
  // merge 元の既存ファイル読み込み失敗は新規化に倒す（load 経路の parse 失敗は throw
  // するのと対照的に、save の merge 元は救済不要）
  const existing = tryCatch(
    () => JSON.parse(readFileSync(appStatePath, "utf8")) as Record<string, unknown>,
  );
  const merged: Record<string, unknown> =
    existing.ok && typeof existing.value === "object" && existing.value !== null
      ? existing.value
      : {};
  // 既知キー（sidebarRepos）は常に全量を明示的に書くため Object.assign の上書きで足りる。
  // 未知 top-level キーだけが merge で生き残る
  Object.assign(merged, state);
  writeFileAtomic(appStatePath, JSON.stringify(sortKeysDeep(merged), null, 2));
}
