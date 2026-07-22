// AppConfig / AppState の永続化。
//
// - `~/.config/gozd/config.json` / `~/.local/state/gozd/app-state.json` は
//   dev / stable で共有する
// - load はファイル不在ならデフォルト値（初回起動）。既存ファイルの欠落フィールド
//   （旧 proto3 JSON は default 値を省略して書いた）は default 充填する
// - 「存在するが型違反」のフィールドはファイルの性格で扱いを分ける（rawJson.ts の契約）:
//   - AppState（機械専有の state）: 破損として検知し、stderr ログ + 初期状態で上書き save
//     （TaskStore の parse 失敗と同じ reinit 経路。ベータ方針: 部分救済を書かない）
//   - AppConfig（ユーザー設定。手編集が正規経路）: 違反フィールドだけ default に倒して
//     stderr ログ。ファイルは書き換えない（VS Code の消費側 validate と同型）。ただし
//     save は全量書き出しのため、default に倒した値は次の設定変更の保存時にファイルへ
//     固定化される（既知の制約。明示編集キーのみ書き込む VS Code 相当は別対応）
// - AppState の save は既存ファイルを raw dict として読み shallow merge し、
//   未知 top-level キー（別バージョンが書いたフィールド）を保持する

import type { AppConfig, AppState } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  asDict,
  lenientBoolean,
  lenientDict,
  lenientNumber,
  lenientOptionalBoolean,
  lenientOptionalNumber,
  lenientString,
  strictBoolean,
  strictDictArray,
  strictString,
  strictStringArray,
} from "./rawJson";

/** appConfigWatcher が watch 対象の導出に使うため export する（パスの SSOT はここ） */
export const appConfigPath = join(homedir(), ".config", "gozd", "config.json");
const appStatePath = join(homedir(), ".local", "state", "gozd", "app-state.json");

/** watcherExclude の初期値（key 不在の初回のみ seed）。VS Code の `files.watcherExclude`
 * デフォルトに倣うが、gozd は git 専用なので `.hg` 系は落とす。`.git/objects` /
 * `.git/subtree-cache` は blob の高churn 領域で、HEAD / refs / packed-refs / index の
 * ref シグナルを含まないため、除外しても branch / status 検知は壊れない。node_modules /
 * build 等は「規約が反転しうる」ためアプリが決め打たず、ユーザーが設定で足す。 */
const DEFAULT_WATCHER_EXCLUDE: Record<string, boolean> = {
  ".git/objects/**": true,
  ".git/subtree-cache/**": true,
};

/** raw な値を Record<string, boolean> に正規化する。boolean 以外の値は stderr ログを残して
 * 落とす（設定系の lenient ポリシー。silent drop 禁止） */
function asBooleanMap(raw: unknown, label: string): Record<string, boolean> {
  const dict = asDict(raw);
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value === "boolean") {
      result[key] = value;
    } else {
      console.error(`[normalizeAppConfig] ${label}.${key}: expected boolean, got ${typeof value}; dropping`);
    }
  }
  return result;
}

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

/** lenient ポリシー（設定系）。型違反フィールドは default に倒して stderr ログを残す。
 * 旧実装の spread は既知キーの型違反を素通しし、section 内の未知キーを保持していた。
 * 明示検証への置き換えで未知の nested キーは load で落ちる（未知キー保持の契約は
 * AppState の top-level のみ。設定の write path 再設計は別対応）。テスト用に export */
export function normalizeAppConfig(raw: unknown): AppConfig {
  const dict = asDict(raw);
  const terminal = lenientDict(dict.terminal, "config.terminal");
  const preview = lenientDict(dict.preview, "config.preview");
  const voicevox = lenientDict(dict.voicevox, "config.voicevox");
  const arcade = lenientDict(dict.arcade, "config.arcade");
  return {
    terminal: {
      theme: lenientString(terminal.theme, "config.terminal.theme"),
      fontFamily: lenientString(terminal.fontFamily, "config.terminal.fontFamily"),
      fontSize: lenientNumber(terminal.fontSize, "config.terminal.fontSize"),
    },
    preview: {
      fontFamily: lenientString(preview.fontFamily, "config.preview.fontFamily"),
      fontSize: lenientNumber(preview.fontSize, "config.preview.fontSize"),
      codeFontFamily: lenientString(preview.codeFontFamily, "config.preview.codeFontFamily"),
    },
    voicevox: {
      enabled: lenientBoolean(voicevox.enabled, "config.voicevox.enabled"),
      speedScale: lenientNumber(voicevox.speedScale, "config.voicevox.speedScale"),
      volumeScale: lenientNumber(voicevox.volumeScale, "config.voicevox.volumeScale"),
      // speakerId / sfxEnabled は「未設定」をキー不在（undefined）で表現する optional
      speakerId: lenientOptionalNumber(voicevox.speakerId, "config.voicevox.speakerId"),
    },
    arcade: {
      sfxEnabled: lenientOptionalBoolean(arcade.sfxEnabled, "config.arcade.sfxEnabled"),
    },
    // key 不在（初回 / watcherExclude を書いていない旧ファイル）のみ default を seed する。
    // 一度 seed 後はユーザーの map をそのまま尊重し、default 行の削除 / false 化を巻き戻さない
    watcherExclude:
      dict.watcherExclude === undefined
        ? { ...DEFAULT_WATCHER_EXCLUDE }
        : asBooleanMap(dict.watcherExclude, "config.watcherExclude"),
  };
}

/** strict ポリシー（state 系）。「存在するが型違反」は RawJsonTypeError を投げ、
 * loadAppStateFrom が reinit に倒す。フィールド不在は従来どおり default 充填。テスト用に export */
export function normalizeAppState(raw: unknown): AppState {
  const dict = asDict(raw);
  const activeDir = strictString(dict.activeDir, "activeDir");
  return {
    sidebarRepos: strictDictArray(dict.sidebarRepos, "sidebarRepos").map((repoDict, i) => ({
      rootDir: strictString(repoDict.rootDir, `sidebarRepos[${i}].rootDir`),
      repoName: strictString(repoDict.repoName, `sidebarRepos[${i}].repoName`),
      isGitRepo: strictBoolean(repoDict.isGitRepo, `sidebarRepos[${i}].isGitRepo`),
      collapsed: strictBoolean(repoDict.collapsed, `sidebarRepos[${i}].collapsed`),
      worktrees: strictDictArray(repoDict.worktrees, `sidebarRepos[${i}].worktrees`).map(
        (wt, j) => ({
          path: strictString(wt.path, `sidebarRepos[${i}].worktrees[${j}].path`),
          branch: strictString(wt.branch, `sidebarRepos[${i}].worktrees[${j}].branch`),
          isMain: strictBoolean(wt.isMain, `sidebarRepos[${i}].worktrees[${j}].isMain`),
        }),
      ),
    })),
    // repo list の空 / 不整合（pool 外 dir、空 id、activeRepoListId 迷子）の正規化は
    // renderer の hydrateFromAppState が担う。ここは型形状の検証 + default 充填だけを行う
    repoLists: strictDictArray(dict.repoLists, "repoLists").map((listDict, i) => ({
      id: strictString(listDict.id, `repoLists[${i}].id`),
      name: strictString(listDict.name, `repoLists[${i}].name`),
      dirOrder: strictStringArray(listDict.dirOrder, `repoLists[${i}].dirOrder`),
    })),
    activeRepoListId: strictString(dict.activeRepoListId, "activeRepoListId"),
    // 「未選択 = キー不在」の optional 契約。空文字は unset に正規化する
    // （undefined 値は JSON.stringify で落ちるため、save 時にキー不在へ戻る）
    activeDir: activeDir !== "" ? activeDir : undefined,
  };
}

/** テスト注入用に path を取る変種（taskStore の createTaskStore(configDir) と同じ流儀）。
 * production は下の loadAppConfig が固定パスを束縛する */
export function loadAppConfigFrom(path: string): AppConfig {
  if (!existsSync(path)) return normalizeAppConfig({});
  const parsed = tryCatch(() => normalizeAppConfig(JSON.parse(readFileSync(path, "utf8"))));
  if (parsed.ok) return parsed.value;
  // ユーザー編集ファイルは reinit しない（修復はユーザーの責務）。default で動かしログのみ残す
  console.error(
    `[loadAppConfig] parse failed at ${path}: ${parsed.error}; using defaults (file left untouched)`,
  );
  return normalizeAppConfig({});
}

export function loadAppConfig(): AppConfig {
  return loadAppConfigFrom(appConfigPath);
}

export function saveAppConfig(config: AppConfig): void {
  // settings UI の「Open settings file (JSON)」で preview 表示する対象のため整形して書く
  writeFileAtomic(appConfigPath, JSON.stringify(config, null, 2));
}

/** 設定ファイルを実体化して絶対パスを返す。未存在（初回起動から一度も保存していない）なら
 * default 充填した現在値を書き出す（VS Code の「Open Settings (JSON)」と同じ挙動）。
 * preview は不在ファイルを "File not found" 表示に倒すため、開く前に実体を保証する。 */
export function ensureAppConfigFile(): string {
  if (!existsSync(appConfigPath)) saveAppConfig(loadAppConfig());
  return appConfigPath;
}

/** テスト注入用に path を取る変種。parse 失敗 / 型違反（RawJsonTypeError）はどちらも破損として
 * stderr ログ + 初期状態で上書き save する（TaskStore.loadFile の reinit と同じ規律。
 * 上書きしないと壊れたファイルが起動のたびに失敗し続ける） */
export function loadAppStateFrom(path: string): AppState {
  if (!existsSync(path)) return normalizeAppState({});
  const parsed = tryCatch(() => normalizeAppState(JSON.parse(readFileSync(path, "utf8"))));
  if (parsed.ok) return parsed.value;
  console.error(`[loadAppState] load failed at ${path}: ${parsed.error}`);
  const empty = normalizeAppState({});
  saveAppStateTo(path, empty);
  console.error(`[loadAppState] corrupted app-state reinitialized at ${path}`);
  return empty;
}

export function loadAppState(): AppState {
  return loadAppStateFrom(appStatePath);
}

/** テスト注入用に path を取る変種 */
function saveAppStateTo(path: string, state: AppState): void {
  // merge 元の既存ファイル読み込み失敗は新規化に倒す（load 経路と対照的に、save の
  // merge 元は救済不要）
  const existing = tryCatch(() => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
  const merged: Record<string, unknown> =
    existing.ok && typeof existing.value === "object" && existing.value !== null
      ? existing.value
      : {};
  // 既知キー（sidebarRepos）は常に全量を明示的に書くため Object.assign の上書きで足りる。
  // 未知 top-level キーだけが merge で生き残る
  Object.assign(merged, state);
  writeFileAtomic(path, JSON.stringify(sortKeysDeep(merged), null, 2));
}

export function saveAppState(state: AppState): void {
  saveAppStateTo(appStatePath, state);
}
