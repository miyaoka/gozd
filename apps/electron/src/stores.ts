// AppConfig / AppState の永続化。Swift 版 `Store/AppConfigStore.swift` /
// `Store/AppStateStore.swift` と同一契約（パス・merge 規律・atomic write）。
//
// - `~/.config/gozd/config.json` / `~/.local/state/gozd/app-state.json` は
//   dev / stable / シェル実装（Swift / Electron）で共有する
// - load はファイル不在ならデフォルト値（初回起動）。未知フィールドは
//   ts-proto fromJSON が既知フィールドしか読まないため自然に無視される
//   （SwiftProtobuf の ignoreUnknownFields = true と同じ挙動）
// - AppState の save は既存ファイルを raw dict として読み shallow merge し、
//   未知 top-level キー（別バージョン・別シェルが書いたフィールド）を保持する。
//   既知キーは merge 前に削除する（proto3 JSON が空 repeated を省略する性質による
//   「最後の repo を消したのに古い sidebarRepos が残る」事故を防ぐ）

import { AppConfig, AppState } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const appConfigPath = join(homedir(), ".config", "gozd", "config.json");
const appStatePath = join(homedir(), ".local", "state", "gozd", "app-state.json");

/** AppState の既知 top-level field 名（proto3 JSON の lower-camel 表記）。
 * proto schema と Swift 版 `AppStateStore.knownTopLevelKeys` に同期して更新する */
const APP_STATE_KNOWN_TOP_LEVEL_KEYS = ["sidebarRepos"];

/** Swift の `.atomic` write と同じ保証: 同 dir の tmp に書いて rename */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

/** Swift 版の `.sortedKeys` に合わせ、キーを再帰的にソートして出力を安定させる */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function loadAppConfig(): AppConfig {
  if (!existsSync(appConfigPath)) return AppConfig.fromJSON({});
  return AppConfig.fromJSON(JSON.parse(readFileSync(appConfigPath, "utf8")));
}

export function saveAppConfig(config: AppConfig): void {
  writeFileAtomic(appConfigPath, JSON.stringify(AppConfig.toJSON(config)));
}

export function loadAppState(): AppState {
  if (!existsSync(appStatePath)) return AppState.fromJSON({});
  return AppState.fromJSON(JSON.parse(readFileSync(appStatePath, "utf8")));
}

export function saveAppState(state: AppState): void {
  // merge 元の既存ファイル読み込み失敗は新規化に倒す（Swift 版の try? と同じ扱い。
  // load 経路の parse 失敗は throw するのと対照的に、save の merge 元は救済不要）
  const existing = tryCatch(
    () => JSON.parse(readFileSync(appStatePath, "utf8")) as Record<string, unknown>,
  );
  const merged: Record<string, unknown> =
    existing.ok && typeof existing.value === "object" && existing.value !== null
      ? existing.value
      : {};
  for (const key of APP_STATE_KNOWN_TOP_LEVEL_KEYS) {
    delete merged[key];
  }
  Object.assign(merged, AppState.toJSON(state) as Record<string, unknown>);
  writeFileAtomic(appStatePath, JSON.stringify(sortKeysDeep(merged), null, 2));
}
