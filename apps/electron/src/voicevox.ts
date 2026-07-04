// VOICEVOX エンジン（HTTP localhost:50021）への薄いラッパー。
// Swift 版 `Voicevox/VoicevoxOps.swift` の対応物。
//
// 設計判断（Swift 版と同一）:
//
// 1. **HTTP は fetch で叩く**。エンジン本体（VOICEVOX.app）は別インストール、
//    gozd は接続するだけ。
//
// 2. **launch は VOICEVOX.app 同梱の engine バイナリ `vv-engine/run` を直接 spawn する**。
//    engine は headless 利用を正規ルートで提供しており、GUI を介さず直接起動するのが
//    公式設計に沿う。Swift 版は Launch Services で bundleId からインストールパスを解決
//    するが、node には対応 API が無いため Spotlight（`mdfind`）で解決し、失敗時は
//    標準インストール場所（/Applications、~/Applications）を確認する。
//    stdout / stderr は親 (gozd) を継承させ、engine の起動失敗ログを観察可能に保つ。
//
// 3. **再生は呼び出し側（renderer）の責務**。speak は wav バイト列のみ返す。

import { tryCatch } from "@gozd/shared";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BASE_URL = "http://127.0.0.1:50021";
const VOICEVOX_BUNDLE_ID = "jp.hiroshiba.voicevox";
// VOICEVOX.app 内部レイアウトの SSOT（Swift 版 engineSegments と対）
const ENGINE_RELATIVE_PATH = join("Contents", "Resources", "vv-engine", "run");

const CHECK_ENGINE_TIMEOUT_MS = 1_500;
const LIST_SPEAKERS_TIMEOUT_MS = 5_000;
const AUDIO_QUERY_TIMEOUT_MS = 10_000;
const SYNTHESIS_TIMEOUT_MS = 60_000;

interface VoicevoxSpeakerStyle {
  name: string;
  id: number;
}

export interface VoicevoxSpeaker {
  name: string;
  styles: VoicevoxSpeakerStyle[];
}

export async function checkEngine(): Promise<boolean> {
  const result = await tryCatch(
    fetch(`${BASE_URL}/version`, { signal: AbortSignal.timeout(CHECK_ENGINE_TIMEOUT_MS) }),
  );
  // Engine 未起動時の polling 用途で頻発するため、接続エラーはログを出さない
  return result.ok && result.value.ok;
}

/** `/speakers` を叩いてキャラ + style 一覧を返す。失敗は undefined（呼び出し側で空 list 化） */
export async function listSpeakers(): Promise<VoicevoxSpeaker[] | undefined> {
  const result = await tryCatch(
    (async () => {
      const resp = await fetch(`${BASE_URL}/speakers`, {
        signal: AbortSignal.timeout(LIST_SPEAKERS_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.error(`[VoicevoxOps.listSpeakers] non-200 status: ${resp.status}`);
        return undefined;
      }
      return (await resp.json()) as unknown;
    })(),
  );
  if (!result.ok) {
    console.error(`[VoicevoxOps.listSpeakers] request/decode failed: ${result.error}`);
    return undefined;
  }
  const root = result.value;
  if (root === undefined) return undefined;
  if (!Array.isArray(root)) {
    console.error("[VoicevoxOps.listSpeakers] root is not array of object");
    return undefined;
  }
  const speakers: VoicevoxSpeaker[] = [];
  for (const entry of root as Record<string, unknown>[]) {
    if (typeof entry.name !== "string" || !Array.isArray(entry.styles)) {
      console.error(`[VoicevoxOps.listSpeakers] skipping malformed speaker entry: ${JSON.stringify(entry)}`);
      continue;
    }
    const styles: VoicevoxSpeakerStyle[] = [];
    for (const style of entry.styles as Record<string, unknown>[]) {
      if (typeof style.name !== "string" || typeof style.id !== "number" || !Number.isInteger(style.id)) {
        console.error(`[VoicevoxOps.listSpeakers] skipping malformed style entry: ${JSON.stringify(style)}`);
        continue;
      }
      styles.push({ name: style.name, id: style.id });
    }
    speakers.push({ name: entry.name, styles });
  }
  return speakers;
}

/** VOICEVOX.app のインストールパスを解決する。Spotlight（mdfind）優先、
 * 不能なら標準インストール場所を確認。見つからなければ undefined */
async function resolveVoicevoxAppPath(): Promise<string | undefined> {
  const found = await tryCatch(
    execFileAsync("mdfind", [`kMDItemCFBundleIdentifier == '${VOICEVOX_BUNDLE_ID}'`]),
  );
  if (found.ok) {
    const [first = ""] = found.value.stdout.split("\n");
    if (first !== "") return first;
  }
  const candidates = [join("/Applications", "VOICEVOX.app"), join(homedir(), "Applications", "VOICEVOX.app")];
  return candidates.find((path) => existsSync(path));
}

// spawn した engine プロセスを保持し、並行 launch の二重 spawn を防ぐ
// （Swift 版 spawnedEngine と同じ役割。exit で自分が保持対象なら解放する）
let spawnedEngine: ChildProcess | undefined;

export async function launch(): Promise<boolean> {
  // 既に engine が応答していれば spawn しない (renderer 側の checkEngine と二重 guard。
  // renderer→native RPC の往復で開く race 窓を縮める)
  if (await checkEngine()) return true;

  const appPath = await resolveVoicevoxAppPath();
  if (appPath === undefined) {
    console.error(`[VoicevoxOps.launch] VOICEVOX.app not found (bundleId=${VOICEVOX_BUNDLE_ID})`);
    return false;
  }
  const enginePath = join(appPath, ENGINE_RELATIVE_PATH);
  const executable = tryCatch(() => accessSync(enginePath, constants.X_OK));
  if (!executable.ok) {
    console.error(`[VoicevoxOps.launch] engine binary not executable at ${enginePath}`);
    return false;
  }

  // race protection: checkEngine と spawn の間に開く async 窓を、spawnedEngine 占有で塞ぐ。
  // 既に spawn 済みで生存している process があれば自分は走らせず true で抜ける
  // （戻り値 true は「engine listen 済み」ではなく「後続は polling で listen を待つ責任」の意味。
  // caller (renderer の doActivate) は launch ok=true の後に waitForEngine を回す前提）
  if (spawnedEngine !== undefined && spawnedEngine.exitCode === null) {
    console.error("[VoicevoxOps.launch] concurrent spawn in-flight; skipping (caller must poll /version)");
    return true;
  }

  // stdout / stderr は親 (gozd) を継承。engine がモデルロード失敗等で起動できない
  // ケースのログを gozd の stderr に流して観察可能性を保つ
  const spawnResult = tryCatch(() => spawn(enginePath, [], { stdio: ["ignore", "inherit", "inherit"] }));
  if (!spawnResult.ok) {
    console.error(`[VoicevoxOps.launch] failed to spawn engine: ${spawnResult.error}`);
    return false;
  }
  const child = spawnResult.value;
  spawnedEngine = child;
  child.on("error", (error) => {
    if (spawnedEngine === child) spawnedEngine = undefined;
    console.error(`[VoicevoxOps.launch] failed to spawn engine: ${error}`);
  });
  child.on("exit", (code, signal) => {
    // spawn 直後に即死した場合、起動成功扱いで return した後 renderer 側は
    // waitForEngine タイムアウトを踏む。stderr に痕跡を残して原因切り分けを可能にする
    if (spawnedEngine === child) spawnedEngine = undefined;
    console.error(`[VoicevoxOps.engine] exited pid=${child.pid} code=${code} signal=${signal}`);
  });
  console.error(`[VoicevoxOps.launch] spawned engine pid=${child.pid} at ${enginePath}`);
  return true;
}

async function audioQuery(text: string, speakerId: number): Promise<Record<string, unknown> | undefined> {
  const params = new URLSearchParams({ text, speaker: String(speakerId) });
  const result = await tryCatch(
    fetch(`${BASE_URL}/audio_query?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(AUDIO_QUERY_TIMEOUT_MS),
    }),
  );
  if (!result.ok) {
    console.error(`[VoicevoxOps.audioQuery] request failed: ${result.error}`);
    return undefined;
  }
  if (!result.value.ok) {
    console.error(`[VoicevoxOps.audioQuery] non-200 status: ${result.value.status} (speaker=${speakerId})`);
    return undefined;
  }
  const json = await tryCatch(result.value.json() as Promise<Record<string, unknown>>);
  if (!json.ok) {
    console.error(`[VoicevoxOps.audioQuery] failed to parse audio_query response: ${json.error}`);
    return undefined;
  }
  return json.value;
}

async function synthesize(audioQueryBody: Record<string, unknown>, speakerId: number): Promise<Uint8Array | undefined> {
  const params = new URLSearchParams({ speaker: String(speakerId) });
  const result = await tryCatch(
    fetch(`${BASE_URL}/synthesis?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioQueryBody),
      signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    }),
  );
  if (!result.ok) {
    console.error(`[VoicevoxOps.synthesize] request failed: ${result.error}`);
    return undefined;
  }
  if (!result.value.ok) {
    console.error(`[VoicevoxOps.synthesize] non-200 status: ${result.value.status} (speaker=${speakerId})`);
    return undefined;
  }
  const buf = await tryCatch(result.value.arrayBuffer());
  if (!buf.ok) {
    console.error(`[VoicevoxOps.synthesize] failed to read wav body: ${buf.error}`);
    return undefined;
  }
  return new Uint8Array(buf.value);
}

/** 1. `audio_query` で韻律 → 2. `synthesis` で wav バイト列を返す。再生は renderer */
export async function speak(params: {
  text: string;
  speedScale: number;
  volumeScale: number;
  speakerId: number;
}): Promise<Uint8Array | undefined> {
  const query = await audioQuery(params.text, params.speakerId);
  if (query === undefined) return undefined;
  query.speedScale = params.speedScale;
  query.volumeScale = params.volumeScale;
  return synthesize(query, params.speakerId);
}
