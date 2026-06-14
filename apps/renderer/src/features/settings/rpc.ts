// AppConfig（グローバル設定）の RPC wrapper + flat-key アダプタ。
//
// proto の AppConfig は section を nest した typed message だが、settings UI の
// schema は dot-key (`terminal.theme` 等) のフラットマップ前提。両者の境界を
// このモジュールで吸収する。
import {
  AppConfig,
  LoadAppConfigRequest,
  LoadAppConfigResponse,
  ProjectConfig,
  ProjectConfigLoadRequest,
  ProjectConfigLoadResponse,
  ProjectConfigSaveRequest,
  ProjectConfigSaveResponse,
  SaveAppConfigRequest,
  SaveAppConfigResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcLoadAppConfig = (req: LoadAppConfigRequest = LoadAppConfigRequest.create()) =>
  rpc("/appConfig/load", req, LoadAppConfigRequest, LoadAppConfigResponse);

export const rpcSaveAppConfig = (config: AppConfig) =>
  rpc(
    "/appConfig/save",
    SaveAppConfigRequest.create({ config }),
    SaveAppConfigRequest,
    SaveAppConfigResponse,
  );

export const rpcProjectConfigLoad = (req: ProjectConfigLoadRequest) =>
  rpc("/projectConfig/load", req, ProjectConfigLoadRequest, ProjectConfigLoadResponse);

export const rpcProjectConfigSave = (dir: string, config: ProjectConfig) =>
  rpc(
    "/projectConfig/save",
    ProjectConfigSaveRequest.create({ dir, config }),
    ProjectConfigSaveRequest,
    ProjectConfigSaveResponse,
  );

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
  };
}

/** dot-key の patch を AppConfig に適用する。未知のキーは無視。 */
function applyDotKey(config: AppConfig, key: string, value: unknown): void {
  const terminal = config.terminal ?? { theme: "", fontFamily: "", fontSize: 0 };
  const preview = config.preview ?? { fontFamily: "", fontSize: 0, codeFontFamily: "" };
  const voicevox = config.voicevox ?? {
    enabled: false,
    speedScale: 0,
    volumeScale: 0,
    speakerId: undefined,
  };
  config.terminal = terminal;
  config.preview = preview;
  config.voicevox = voicevox;
  switch (key) {
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

/** flat な patch を load → mutate → save の RMW で AppConfig に書き込む */
export async function patchAppConfig(patch: Record<string, unknown>): Promise<void> {
  const loaded = await rpcLoadAppConfig();
  const config: AppConfig = loaded.config ?? AppConfig.create();
  for (const [key, value] of Object.entries(patch)) {
    applyDotKey(config, key, value);
  }
  await rpcSaveAppConfig(config);
}

/** ProjectConfig を flat な Record にフラット化する */
export function flattenProjectConfig(c: ProjectConfig | undefined): Record<string, unknown> {
  return {
    worktreeSymlinks: c?.worktreeSymlinks ?? [],
  };
}

/** ProjectConfig の flat patch を RMW で書き込む */
export async function patchProjectConfig(
  dir: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const loaded = await rpcProjectConfigLoad({ dir });
  const config: ProjectConfig = loaded.config ?? { worktreeSymlinks: [] };
  if (
    "worktreeSymlinks" in patch &&
    Array.isArray(patch.worktreeSymlinks) &&
    patch.worktreeSymlinks.every((v): v is string => typeof v === "string")
  ) {
    config.worktreeSymlinks = patch.worktreeSymlinks;
  }
  await rpcProjectConfigSave(dir, config);
}
