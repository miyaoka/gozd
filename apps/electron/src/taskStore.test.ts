// TaskStore の統合テスト。Swift 版 `TaskStoreTests.swift` のうち、今回移植した mutation
// 経路（add / setTitle / remove / resumableSessionIds / detachSession）のケースを対で維持する。
// attachSession / clearDeadSession のケースは hooks 統合ステップで移植する。
//
// 両シェルが同じ tasks.json を共有するため、upsert / no-op / 保持の意味論が Swift 版と
// ずれると相互破壊になる。ケース名の対応を崩さないこと。

import { ghRefForPr, type Task, type TaskList } from "@gozd/rpc";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTaskStore, resolveProjectKey, TaskNotFoundError } from "./taskStore";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "",
    worktreeDir: "",
    ghRef: undefined,
    createdAt: "",
    sessionId: "",
    closedByUser: false,
    userTitle: "",
    terminalTitle: "",
    ghTitle: "",
    ...overrides,
  };
}

describe("TaskStore", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(): { store: ReturnType<typeof createTaskStore>; dir: string; configDir: string } {
    const configDir = makeTempDir("gozd-taskstore-config-");
    const dir = makeTempDir("gozd-taskstore-project-");
    return { store: createTaskStore(configDir), dir, configDir };
  }

  /** fixture task を直接 tasks.json に書き込む（attachSession 未移植のため sessionId 付き
   * task は API 経由で作れない。Swift テストの直接構築と同じ立場） */
  async function writeTasksFile(configDir: string, dir: string, tasks: Task[]): Promise<string> {
    const path = join(configDir, "projects", await resolveProjectKey(dir), "tasks.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ tasks } satisfies TaskList));
    return path;
  }

  test("add: 同 worktreeDir + 同 ghRef の既存 task は再活性化される (PR/issue 再選択)", async () => {
    const { store, dir } = setup();
    const first = await store.add({ dir, ghTitle: "old title", worktreeDir: "/wt/a", ghRef: ghRefForPr(42) });
    // closed 状態を作る（detachSession は sessionId 起点なので直接ファイルを書き換えない
    // 代わりに、再 add で closedByUser=false へ戻る挙動を上書きタイトルとセットで検証）
    const second = await store.add({ dir, ghTitle: "new title", worktreeDir: "/wt/a", ghRef: ghRefForPr(42) });
    expect(second.id).toBe(first.id);
    expect(second.ghTitle).toBe("new title");
    expect(second.closedByUser).toBe(false);
    expect((await store.list(dir)).length).toBe(1);
  });

  test("add: ghRef 無しは upsert せず常に新規作成", async () => {
    const { store, dir } = setup();
    const first = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: undefined });
    const second = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: undefined });
    expect(second.id).not.toBe(first.id);
    expect((await store.list(dir)).length).toBe(2);
  });

  test("add: 別 worktree の同 ghRef は別 task として扱う", async () => {
    const { store, dir } = setup();
    const first = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: ghRefForPr(42) });
    const second = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/b", ghRef: ghRefForPr(42) });
    expect(second.id).not.toBe(first.id);
    expect((await store.list(dir)).length).toBe(2);
  });

  test("add: 新規 task は userTitle 空 + createdAt 秒粒度 ISO 8601", async () => {
    const { store, dir } = setup();
    const task = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: undefined });
    expect(task.userTitle).toBe("");
    // Swift ISO8601DateFormatter と同じ秒粒度（ミリ秒なし）であること
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("resumableSessionIds: sessionId 非空 + !closedByUser + worktreeDir 一致の task だけ返す", async () => {
    const { store, dir, configDir } = setup();
    // resumableSessionIds(dir) は list(dir) を worktreeDir === dir で絞るため、
    // 一致させたい fixture は worktreeDir に dir 自身を持たせる
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: dir, sessionId: "sid-live" }),
      makeTask({ id: "2", worktreeDir: dir, sessionId: "sid-closed", closedByUser: true }),
      makeTask({ id: "3", worktreeDir: dir, sessionId: "" }),
      makeTask({ id: "4", worktreeDir: "/wt/other", sessionId: "sid-other-wt" }),
    ]);
    expect(await store.resumableSessionIds(dir)).toEqual(["sid-live"]);
  });

  test("remove: 指定 id の task を削除", async () => {
    const { store, dir } = setup();
    const task = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: undefined });
    const keep = await store.add({ dir, ghTitle: "u", worktreeDir: "/wt/a", ghRef: undefined });
    await store.remove(dir, task.id);
    const remaining = await store.list(dir);
    expect(remaining.map((t) => t.id)).toEqual([keep.id]);
  });

  test("remove: 存在しない id は no-op", async () => {
    const { store, dir } = setup();
    await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: undefined });
    await store.remove(dir, "no-such-id");
    expect((await store.list(dir)).length).toBe(1);
  });

  test("detachSession: ghRef 無し task も残し、sessionID 保持 + closed_by_user=true", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1" })]);
    await store.detachSession(dir, "sid-1");
    const [task] = await store.list(dir);
    expect(task?.sessionId).toBe("sid-1");
    expect(task?.closedByUser).toBe(true);
  });

  test("detachSession: ghRef 有り task も同じ動き (sessionID 保持 + closed_by_user=true)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1", ghRef: ghRefForPr(7) }),
    ]);
    await store.detachSession(dir, "sid-1");
    const [task] = await store.list(dir);
    expect(task?.sessionId).toBe("sid-1");
    expect(task?.closedByUser).toBe(true);
    expect(task?.ghRef).toEqual(ghRefForPr(7));
  });

  test("detachSession: sessionId 不一致なら no-op (silent return)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1" })]);
    await store.detachSession(dir, "sid-unknown");
    const [task] = await store.list(dir);
    expect(task?.closedByUser).toBe(false);
  });

  test("setTerminalTitle / setUserTitle: 対象 task に書き込み、不在 id は throw", async () => {
    const { store, dir } = setup();
    const task = await store.add({ dir, ghTitle: "t", worktreeDir: "/wt/a", ghRef: undefined });
    const withTerminal = await store.setTerminalTitle(dir, task.id, "osc title");
    expect(withTerminal.terminalTitle).toBe("osc title");
    const withUser = await store.setUserTitle(dir, task.id, "my title");
    expect(withUser.userTitle).toBe("my title");
    // 空文字クリア（reset 経路）
    const cleared = await store.setUserTitle(dir, task.id, "");
    expect(cleared.userTitle).toBe("");
    expect(store.setTerminalTitle(dir, "no-such-id", "x")).rejects.toThrow(TaskNotFoundError);
    expect(store.setUserTitle(dir, "no-such-id", "x")).rejects.toThrow(TaskNotFoundError);
  });

  test("attachSession: 既に同 sessionID の task があれば closed=false に戻して no-op (resume 復帰)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1", closedByUser: true, ghTitle: "keep" }),
    ]);
    await store.attachSession(dir, "sid-1", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.closedByUser).toBe(false);
    expect(tasks[0]?.ghTitle).toBe("keep");
  });

  test("attachSession: sessionId 空の最新 task に attach + closed=false を立てる", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "old", worktreeDir: "/wt/a", createdAt: "2026-07-01T00:00:00Z" }),
      makeTask({ id: "new", worktreeDir: "/wt/a", createdAt: "2026-07-02T00:00:00Z", closedByUser: true }),
    ]);
    await store.attachSession(dir, "sid-new", "/wt/a");
    const tasks = await store.list(dir);
    const picked = tasks.find((t) => t.id === "new");
    expect(picked?.sessionId).toBe("sid-new");
    expect(picked?.closedByUser).toBe(false);
    expect(tasks.find((t) => t.id === "old")?.sessionId).toBe("");
  });

  test("attachSession: createdAt 同値なら id 辞書順最大を pick する (tie-break)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "aaa", worktreeDir: "/wt/a", createdAt: "2026-07-01T00:00:00Z" }),
      makeTask({ id: "zzz", worktreeDir: "/wt/a", createdAt: "2026-07-01T00:00:00Z" }),
    ]);
    await store.attachSession(dir, "sid-1", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.find((t) => t.id === "zzz")?.sessionId).toBe("sid-1");
    expect(tasks.find((t) => t.id === "aaa")?.sessionId).toBe("");
  });

  test("attachSession: 該当 task 無しなら新規 task を作成 (Claude 直接起動経路)", async () => {
    const { store, dir } = setup();
    await store.attachSession(dir, "sid-direct", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.sessionId).toBe("sid-direct");
    expect(tasks[0]?.worktreeDir).toBe("/wt/a");
    expect(tasks[0]?.ghRef).toBeUndefined();
  });

  test("attachSession + clearDeadSession(markClosedByUser=false): 自動転移で同一 task に新 sid attach", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-dead", ghTitle: "task body" }),
    ]);
    // resume 失敗 → sessionId を空に戻す（fallback 経路なので closed は据え置き）
    await store.clearDeadSession(dir, "sid-dead", false);
    // 直後の attachSession(新 sid) が同一 task を候補ピックで拾う
    await store.attachSession(dir, "sid-new", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.sessionId).toBe("sid-new");
    expect(tasks[0]?.ghTitle).toBe("task body");
    expect(tasks[0]?.closedByUser).toBe(false);
  });

  test("attachSession: 他 worktree の sessionId 空 task は attach 対象外", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [makeTask({ id: "1", worktreeDir: "/wt/other" })]);
    await store.attachSession(dir, "sid-1", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.length).toBe(2);
    expect(tasks.find((t) => t.id === "1")?.sessionId).toBe("");
    expect(tasks.find((t) => t.worktreeDir === "/wt/a")?.sessionId).toBe("sid-1");
  });

  test("attachSession: closed (sid 保持) task は奪わず、新 sid は別 task を作る (hijack なし)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-kept", closedByUser: true }),
    ]);
    await store.attachSession(dir, "sid-new", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.length).toBe(2);
    expect(tasks.find((t) => t.id === "1")?.sessionId).toBe("sid-kept");
  });

  test("attachSession: ghRef 有り closed task も奪わず、素 claude (新 sid) は別 task を作る", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-kept", closedByUser: true, ghRef: ghRefForPr(9) }),
    ]);
    await store.attachSession(dir, "sid-new", "/wt/a");
    const tasks = await store.list(dir);
    expect(tasks.length).toBe(2);
    const kept = tasks.find((t) => t.id === "1");
    expect(kept?.sessionId).toBe("sid-kept");
    expect(kept?.ghRef).toEqual(ghRefForPr(9));
  });

  test("clearDeadSession(markClosedByUser=true): sessionID 空 + closed_by_user=true (terminal close 経路)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1" })]);
    await store.clearDeadSession(dir, "sid-1", true);
    const [task] = await store.list(dir);
    expect(task?.sessionId).toBe("");
    expect(task?.closedByUser).toBe(true);
  });

  test("clearDeadSession(markClosedByUser=false): closed_by_user 据え置き (session-start fallback)", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1" })]);
    await store.clearDeadSession(dir, "sid-1", false);
    const [task] = await store.list(dir);
    expect(task?.sessionId).toBe("");
    expect(task?.closedByUser).toBe(false);
  });

  test("clearDeadSession: sessionId 不一致なら no-op / task 本体は残す", async () => {
    const { store, dir, configDir } = setup();
    await writeTasksFile(configDir, dir, [
      makeTask({ id: "1", worktreeDir: "/wt/a", sessionId: "sid-1", ghTitle: "body" }),
    ]);
    await store.clearDeadSession(dir, "sid-unknown", true);
    const [task] = await store.list(dir);
    expect(task?.sessionId).toBe("sid-1");
    expect(task?.ghTitle).toBe("body");
  });

  test("loadFile: 壊れた tasks.json は空 list で reinit される（後方互換なし規約）", async () => {
    const { store, dir, configDir } = setup();
    const path = await writeTasksFile(configDir, dir, []);
    writeFileSync(path, "{ broken json");
    expect(await store.list(dir)).toEqual([]);
    // 上書き save されて以後は正常 parse できること（空 list も明示的にキーを書く。
    // 旧 proto3 JSON の「空 repeated 省略」はここで廃止）
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ tasks: [] });
  });
});
