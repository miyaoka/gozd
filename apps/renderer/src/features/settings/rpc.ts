// AppConfig（グローバル設定）の RPC wrapper + flat-key アダプタ。
//
// AppConfig は section を nest した typed message だが、settings UI の
// schema は dot-key (`terminal.theme` 等) のフラットマップ前提。両者の境界を
// このモジュールで吸収する。
import type {
  AppConfig,
  EnsureAppConfigFileResponse,
  ProjectConfig,
  ProjectConfigEnsureFileRequest,
  ProjectConfigEnsureFileResponse,
  ProjectConfigLoadRequest,
  ProjectConfigLoadResponse,
  ProjectConfigSaveResponse,
} from "@gozd/rpc";

import { rpc, updateAppConfig } from "../../shared/rpc";

export const rpcEnsureAppConfigFile = () =>
  rpc<EnsureAppConfigFileResponse>("/appConfig/ensureFile", {});

export const rpcProjectConfigLoad = (req: ProjectConfigLoadRequest) =>
  rpc<ProjectConfigLoadResponse>("/projectConfig/load", req);

export const rpcProjectConfigEnsureFile = (req: ProjectConfigEnsureFileRequest) =>
  rpc<ProjectConfigEnsureFileResponse>("/projectConfig/ensureFile", req);

const rpcProjectConfigSave = (dir: string, config: ProjectConfig) =>
  rpc<ProjectConfigSaveResponse>("/projectConfig/save", { dir, config });

// --- flat-key アダプタ ---

/** AppConfig を dot-key の Record にフラット化する */
export function flattenAppConfig(c: AppConfig | undefined): Record<string, unknown> {
  return {
    "terminal.theme": c?.terminal?.theme ?? "",
    "terminal.fontFamily": c?.terminal?.fontFamily ?? "",
    "terminal.fontSize": c?.terminal?.fontSize ?? 14,
    "preview.fontFamily": c?.preview?.fontFamily ?? "",
    "preview.fontSize": c?.preview?.fontSize ?? 14,
    "preview.codeFontFamily": c?.preview?.codeFontFamily ?? "",
    "voicevox.enabled": c?.voicevox?.enabled ?? false,
    "voicevox.speedScale": c?.voicevox?.speedScale ?? 1.5,
    "voicevox.volumeScale": c?.voicevox?.volumeScale ?? 1.0,
    // voicevox.speakerId は VoicevoxSpeakerWidget が store と直結するため flatten 経路を通らない
    watcherExclude: c?.watcherExclude ?? {},
  };
}

/** value が Record<string, boolean> か判定する */
function isStringBooleanMap(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "boolean")
  );
}

/** dot-key の patch を AppConfig に適用する。未知のキーは無視。 */
function applyDotKey(config: AppConfig, key: string, value: unknown): void {
  // main 側 loadAppConfig が全セクションを default 充填して返す契約のため、
  // ここでのセクション存在チェックは不要
  const { terminal, preview, voicevox } = config;
  switch (key) {
    case "watcherExclude":
      if (isStringBooleanMap(value)) config.watcherExclude = value;
      break;
    case "terminal.theme":
      if (typeof value === "string") terminal.theme = value;
      break;
    case "terminal.fontFamily":
      if (typeof value === "string") terminal.fontFamily = value;
      break;
    case "terminal.fontSize":
      if (typeof value === "number") terminal.fontSize = value;
      break;
    case "preview.fontFamily":
      if (typeof value === "string") preview.fontFamily = value;
      break;
    case "preview.fontSize":
      if (typeof value === "number") preview.fontSize = value;
      break;
    case "preview.codeFontFamily":
      if (typeof value === "string") preview.codeFontFamily = value;
      break;
    case "voicevox.enabled":
      if (typeof value === "boolean") voicevox.enabled = value;
      break;
    case "voicevox.speedScale":
      if (typeof value === "number") voicevox.speedScale = value;
      break;
    case "voicevox.volumeScale":
      if (typeof value === "number") voicevox.volumeScale = value;
      break;
  }
}

/** flat な patch を直列化キュー経由で AppConfig に書き込む */
export async function patchAppConfig(patch: Record<string, unknown>): Promise<void> {
  await updateAppConfig((config) => {
    for (const [key, value] of Object.entries(patch)) {
      applyDotKey(config, key, value);
    }
  });
}

/** ProjectConfig を flat な Record にフラット化する */
export function flattenProjectConfig(c: ProjectConfig | undefined): Record<string, unknown> {
  return {
    worktreeSymlinks: c?.worktreeSymlinks ?? [],
    setupScript: c?.setupScript ?? "",
  };
}

/** ProjectConfig の flat patch を RMW で書き込む */
export async function patchProjectConfig(
  dir: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const loaded = await rpcProjectConfigLoad({ dir });
  const config: ProjectConfig = loaded.config;
  if (
    "worktreeSymlinks" in patch &&
    Array.isArray(patch.worktreeSymlinks) &&
    patch.worktreeSymlinks.every((v): v is string => typeof v === "string")
  ) {
    config.worktreeSymlinks = patch.worktreeSymlinks;
  }
  if ("setupScript" in patch && typeof patch.setupScript === "string") {
    config.setupScript = patch.setupScript;
  }
  await rpcProjectConfigSave(dir, config);
}
