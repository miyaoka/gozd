// プロジェクト固有 Task の永続化。Swift 版 `Store/TaskStore.swift` /
// `Store/ProjectKey.swift` の対応物。
//
// task ≠ Claude session。task は PR/issue/手動操作で生まれる永続オブジェクトで、
// Claude session は task に attach する短命属性 (task.sessionId) として持つ。
// attachSession / clearDeadSession は hook 駆動のため hooks 統合ステップで移植する
// （SessionStart hook の consume 経路なしに移植しても発火経路が存在しない）。
//
// - projectKey は `<repoName>-<sha256(realpath)[0..12]>`。worktree 配下のどの dir から
//   呼ばれても main repo root に解決した上で同一 projectKey に揃える
// - 永続化形式は TaskList を素の JSON で書いたもの（キー名 / ghRef.kind の文字列は
//   旧 proto3 JSON mapping と同一。**merge までは main branch の Swift 版 gozd と同じ
//   tasks.json を共有する**ため、mutation の意味論もワイヤ表現も Swift 版と一致させる）
// - parse 失敗時は**空 list で上書き save**する（後方互換を作らない規約。主データ
//   (git worktree list) を JOIN する立場のため、load 経路から throw を伝播させない）。
//   stderr に reinit ログを残して観察可能性を保つ

import type { GhRef, Task, TaskList } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runGit } from "./git/gitRunner";
import {
  asDict,
  RawJsonTypeError,
  strictBoolean,
  strictDictArray,
  strictNumber,
  strictString,
} from "./rawJson";

const defaultConfigDir = join(homedir(), ".config", "gozd");

/** realpath 解決。対象が存在しない等で失敗したら入力をそのまま返す
 * （Swift の resolvingSymlinksInPath は失敗しない API のため挙動を揃える） */
function realpathOrSelf(dir: string): string {
  const result = tryCatch(() => realpathSync(dir));
  return result.ok ? result.value : dir;
}

/** `git rev-parse --git-common-dir` の親 = main worktree のパス。git 外 / 失敗時は dir 自体 */
export async function resolveMainRepoRoot(dir: string): Promise<string> {
  const result = await tryCatch(runGit(["rev-parse", "--git-common-dir"], dir));
  if (!result.ok) return realpathOrSelf(dir);
  const text = result.value.trim();
  // common-dir が相対パスなら dir 起点で resolve する
  const commonDir = isAbsolute(text) ? text : join(dir, text);
  return realpathOrSelf(dirname(commonDir));
}

/** main repo root から projectKey を生成する。形式変更は全 store の保存先を変えるため
 * 変更時は移行コードが必要（Swift 版 ProjectKey と完全同一の算式であること） */
function computeProjectKey(mainRepoRoot: string): string {
  const resolved = realpathOrSelf(mainRepoRoot);
  const hash = createHash("sha256").update(resolved, "utf8").digest("hex");
  return `${basename(resolved)}-${hash.slice(0, 12)}`;
}

/** dir（main / worktree / 配下 subdir のいずれでも可）から projectKey を解決する。
 * Swift 版 `ProjectKey.resolveAndCompute` の対応物。worktree 配置先の決定
 * （worktreeOps）と永続ファイルパスの両方がこの値を共有する */
export async function resolveProjectKey(dir: string): Promise<string> {
  return computeProjectKey(await resolveMainRepoRoot(dir));
}

/** gozd の worktree 配置 root（projectKey 抜き）。`<root>/<projectKey>/<leaf>` が各 worktree のパス。
 * worktreeOps（worktree の作成先）と claudeSessionLog（revive の cwd prefix 判定）が同一 base を
 * 指すことに revive の「cwd 1 バイト一致」が依存するため、literal を 2 箇所に散らさず SSOT を置く。 */
export function gozdWorktreesRoot(): string {
  return join(homedir(), ".local", "share", "gozd", "worktrees");
}

/** Swift ISO8601DateFormatter (withInternetDateTime) と同じ秒粒度表記に揃える。
 * createdAt は文字列比較で候補ピックの順序キーになるため、両シェルで表記を揃えないと
 * ミリ秒あり/なしの混在で同一秒 tie-break の意味が変わる */
function iso8601Seconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sameGhRef(a: GhRef, b: GhRef): boolean {
  return a.kind === b.kind && a.number === b.number;
}

/** ghRef の strict 検証。唯一の例外として、kind の**未知の文字列値**だけは ghRef ごと落とす
 * （`GhRefKind` は tasks.json に永続化される文字列 enum で、新 kind を書いた新バージョンの
 * ファイルを旧バージョンが読む forward-compat 経路が docs/rpc.md で契約化されているため。
 * 表示 / upsert 判定が意味を持たないので drop し、観察ログを残す）。
 * それ以外の型違反（非 object / 非文字列 kind / 非 number の number）は state 系 strict
 * ポリシーどおり RawJsonTypeError で reinit に倒す */
function normalizeGhRef(raw: unknown, label: string): GhRef | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RawJsonTypeError(label, "object", raw);
  }
  const dict = asDict(raw);
  const kind = strictString(dict.kind, `${label}.kind`);
  if (kind !== "GH_REF_KIND_PR" && kind !== "GH_REF_KIND_ISSUE") {
    console.error(`[TaskStore] normalizeGhRef: unknown kind ${JSON.stringify(kind)}; dropping ghRef`);
    return undefined;
  }
  return { kind, number: strictNumber(dict.number, `${label}.number`) };
}

/** 旧 proto3 JSON が省略した default 値フィールドを充填する（`rawJson.ts` の契約参照）。
 * 「存在するが型違反」は strict 検証で RawJsonTypeError を投げ、loadFile の既存 tryCatch が
 * parse 失敗と同じ reinit 経路（stderr ログ + 空で上書き save）に倒す。
 * 例外は ghRef.kind の未知文字列値の drop のみ（normalizeGhRef 参照） */
function normalizeTaskList(raw: unknown): TaskList {
  return {
    tasks: strictDictArray(asDict(raw).tasks, "tasks").map((dict, i) => ({
      id: strictString(dict.id, `tasks[${i}].id`),
      worktreeDir: strictString(dict.worktreeDir, `tasks[${i}].worktreeDir`),
      createdAt: strictString(dict.createdAt, `tasks[${i}].createdAt`),
      sessionId: strictString(dict.sessionId, `tasks[${i}].sessionId`),
      closedByUser: strictBoolean(dict.closedByUser, `tasks[${i}].closedByUser`),
      userTitle: strictString(dict.userTitle, `tasks[${i}].userTitle`),
      terminalTitle: strictString(dict.terminalTitle, `tasks[${i}].terminalTitle`),
      ghTitle: strictString(dict.ghTitle, `tasks[${i}].ghTitle`),
      ghRef: normalizeGhRef(dict.ghRef, `tasks[${i}].ghRef`),
    })),
  };
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

/** configDir 注入可能な store factory。production は下の `taskStore` 単一インスタンスを
 * 使い、テストは temp configDir で分離する（Swift TaskStore の init(configDir:) と同型） */
export function createTaskStore(configDir: string) {
  async function tasksFilePath(dir: string): Promise<string> {
    const projectKey = computeProjectKey(await resolveMainRepoRoot(dir));
    return join(configDir, "projects", projectKey, "tasks.json");
  }

  function saveFile(path: string, list: TaskList): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(list));
    renameSync(tmpPath, path);
  }

  async function loadFile(dir: string): Promise<TaskList> {
    const path = await tasksFilePath(dir);
    if (!existsSync(path)) return { tasks: [] };
    const parsed = tryCatch(() => normalizeTaskList(JSON.parse(readFileSync(path, "utf8"))));
    if (parsed.ok) return parsed.value;
    console.error(`[TaskStore] loadFile: parse failed at ${path}: ${parsed.error}`);
    const empty: TaskList = { tasks: [] };
    saveFile(path, empty);
    console.error(`[TaskStore] loadFile: corrupted tasks.json reinitialized at ${path}`);
    return empty;
  }

  async function save(dir: string, list: TaskList): Promise<void> {
    saveFile(await tasksFilePath(dir), list);
  }

  /** projectKey 内の全 Task を返す。handleGitWorktreeList の WorktreeEntry.tasks JOIN に使う */
  async function list(dir: string): Promise<Task[]> {
    return (await loadFile(dir)).tasks;
  }

  /** Task を作成または再活性化する。
   *
   * - `ghRef` 指定があり、同 `worktreeDir` + 同 `ghRef` の既存 task が見つかれば
   *   **upsert**: ghTitle を最新タイトルで上書きし closedByUser=false に倒して返す。
   *   userTitle はユーザー編集の確定値なので触らない（本関数は書き込み経路を持たない）
   * - それ以外は新規 task を UUID で作成。userTitle は空
   *   （編集 dialog の setUserTitle 経由でしか設定されない契約） */
  async function add(params: {
    dir: string;
    ghTitle: string;
    worktreeDir: string;
    ghRef: GhRef | undefined;
  }): Promise<Task> {
    const { dir, ghTitle, worktreeDir, ghRef } = params;
    const fileList = await loadFile(dir);
    if (ghRef !== undefined) {
      const existing = fileList.tasks.find(
        (task) =>
          task.worktreeDir === worktreeDir && task.ghRef !== undefined && sameGhRef(task.ghRef, ghRef),
      );
      if (existing !== undefined) {
        existing.ghTitle = ghTitle;
        existing.closedByUser = false;
        await save(dir, fileList);
        return existing;
      }
    }
    const task: Task = {
      id: randomUUID(),
      worktreeDir,
      ghRef,
      createdAt: iso8601Seconds(),
      sessionId: "",
      closedByUser: false,
      userTitle: "",
      terminalTitle: "",
      ghTitle,
    };
    fileList.tasks.push(task);
    await save(dir, fileList);
    return task;
  }

  /** OSC ターミナルタイトル経由で観測した値を Task に書き込む。
   * userTitle が空のときの表示フォールバックに使う観測値 */
  async function setTerminalTitle(dir: string, id: string, terminalTitle: string): Promise<Task> {
    const fileList = await loadFile(dir);
    const task = fileList.tasks.find((t) => t.id === id);
    if (task === undefined) throw new TaskNotFoundError(id);
    task.terminalTitle = terminalTitle;
    await save(dir, fileList);
    return task;
  }

  /** 編集 dialog からのユーザー明示タイトル設定（新規タイトル / クリア両用）。
   * 空文字で userTitle をクリアし、ghTitle / terminalTitle のフォールバックチェーンに戻す */
  async function setUserTitle(dir: string, id: string, userTitle: string): Promise<Task> {
    const fileList = await loadFile(dir);
    const task = fileList.tasks.find((t) => t.id === id);
    if (task === undefined) throw new TaskNotFoundError(id);
    task.userTitle = userTitle;
    await save(dir, fileList);
    return task;
  }

  /** ⋮ メニューからの明示削除。存在しない id は no-op（Swift 版 removeAll と同じ） */
  async function remove(dir: string, id: string): Promise<void> {
    const fileList = await loadFile(dir);
    fileList.tasks = fileList.tasks.filter((task) => task.id !== id);
    await save(dir, fileList);
  }

  /** Claude session-start hook を Task に attach する。
   *
   * 優先順位（Swift attachSession と同一意味論）:
   * (1) 既に sessionId が一致する task → resume 確定経路。closedByUser を false に戻すのみ
   * (2) 同 worktreeDir の sessionId 空 task に attach。pick は createdAt 最大（= 最新）、
   *     tie-break は id 辞書順最大（createdAt は秒粒度なので同値がありうる。tie-break を
   *     入れないと入力順序依存で非決定的になる）。closed でも sessionId が空なら candidate
   *     に含め、pick 時に false へ倒す。**closed だが sessionId を保持する（= resume 可能な）
   *     task は candidate にしない**（新 session が既存 task の sid を奪う hijack はしない）
   * (3) 該当なし → 新規 task を作成し sessionId を入れる（Claude 直接起動経路） */
  async function attachSession(dir: string, sessionId: string, worktreeDir: string): Promise<void> {
    const fileList = await loadFile(dir);
    const existing = fileList.tasks.find((t) => t.sessionId === sessionId);
    if (existing !== undefined) {
      if (existing.closedByUser) {
        existing.closedByUser = false;
        await save(dir, fileList);
      }
      return;
    }
    const candidates = fileList.tasks.filter((t) => t.worktreeDir === worktreeDir && t.sessionId === "");
    const [pick] = candidates.toSorted((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
    if (pick !== undefined) {
      pick.sessionId = sessionId;
      if (pick.closedByUser) pick.closedByUser = false;
    } else {
      fileList.tasks.push({
        id: randomUUID(),
        worktreeDir,
        ghRef: undefined,
        createdAt: iso8601Seconds(),
        sessionId,
        closedByUser: false,
        userTitle: "",
        terminalTitle: "",
        ghTitle: "",
      });
    }
    await save(dir, fileList);
  }

  /** resume 失敗検出経路（`claude --resume` が transcript 不在等で error 終了）で呼ぶ。
   * task 本体は削除せず sessionId だけ空にし、次のクリックで素の claude 起動に流す。
   * markClosedByUser=true（removeByPty 経路: pane close + SessionStart 不達）は
   * closedByUser も立てる。false（session-start fallback 経路）は据え置き —
   * 直後の attachSession が候補ピックで同一 task に転移する */
  async function clearDeadSession(dir: string, sessionId: string, markClosedByUser: boolean): Promise<void> {
    const fileList = await loadFile(dir);
    const task = fileList.tasks.find((t) => t.sessionId === sessionId);
    if (task === undefined) return;
    task.sessionId = "";
    if (markClosedByUser) task.closedByUser = true;
    await save(dir, fileList);
  }

  /** SessionEnd hook / terminal close 由来。task 本体は削除せず sessionId も保持
   * （次回 `claude --resume` の起点）。closedByUser=true でサイドバー表示を closed に
   * 切り替える。sessionId 不一致なら no-op（silent return、Swift 版と同じ） */
  async function detachSession(dir: string, sessionId: string): Promise<void> {
    const fileList = await loadFile(dir);
    const task = fileList.tasks.find((t) => t.sessionId === sessionId);
    if (task === undefined) return;
    task.closedByUser = true;
    await save(dir, fileList);
  }

  /** worktree 物理削除からの連動掃除。該当 worktreeDir に紐づく全 Task を削除し、
   * worktree 削除後に Task が孤児として永続化に残るのを防ぐ */
  async function removeByWorktree(dir: string, worktreePath: string): Promise<void> {
    const fileList = await loadFile(dir);
    fileList.tasks = fileList.tasks.filter((task) => task.worktreeDir !== worktreePath);
    await save(dir, fileList);
  }

  return {
    list,
    add,
    setTerminalTitle,
    setUserTitle,
    remove,
    attachSession,
    clearDeadSession,
    detachSession,
    removeByWorktree,
  };
}

type TaskStore = ReturnType<typeof createTaskStore>;

/** production 用の単一インスタンス（`~/.config/gozd/`）。routes.ts はこれを使う */
export const taskStore = createTaskStore(defaultConfigDir);
