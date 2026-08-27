// newWorktree ハンドラの一意性テスト。
//
// 検証対象は「判定と作成が同じ参照の要求どうしで interleave しないこと」なので、
// git と永続化は注入した fake で置き換える。fake の create は作成済みの参照を自分の
// 台帳に足し、findExisting はその台帳を引く — つまり **実装と同じ read-modify-write の
// 窓**を持つ。窓を跨いで直列化できていなければ 2 件作られる。

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CreateTaskWorktreeRequest, GhRef, NewWorktreeMessage, Task } from "@gozd/rpc";
import { ghRefForIssue, ghRefForPr } from "@gozd/rpc";
import { createNewWorktreeHandler, type NewWorktreeDeps } from "./newWorktree";
import type { PushFn } from "./rpcDispatcher";

const ROOT = "/repo";

function sameRef(a: GhRef, b: GhRef): boolean {
  return a.kind === b.kind && a.number === b.number;
}

/** 実 git / 実ホームを触らない fake。created が tasks.json の代役。
 * maxInFlight は create の重なりの最大値で、逐次化の粒度をここで判定する
 * （実時間で測ると閾値が実行環境に依存し、負荷で偽陽性・偽陰性を出す） */
function createFakeDeps(options: { createDelayMs: number }) {
  const created: Task[] = [];
  let inFlight = 0;
  const counters = { maxInFlight: 0 };
  const deps: NewWorktreeDeps = {
    resolveRoot: (dir) => Promise.resolve(dir === "/repo/sub" ? ROOT : dir),
    findExisting: async (rootDir, ghRef) => {
      // 判定も I/O なので await 境界を持つ。ここが割り込み点になる
      await Promise.resolve();
      if (rootDir !== ROOT) return undefined;
      return created.find((task) => task.ghRef !== undefined && sameRef(task.ghRef, ghRef));
    },
    create: async (req: CreateTaskWorktreeRequest) => {
      inFlight += 1;
      counters.maxInFlight = Math.max(counters.maxInFlight, inFlight);
      // git worktree add に相当する秒単位の窓
      await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));
      inFlight -= 1;
      const dir = `${ROOT}/wt${created.length + 1}`;
      const task: Task = {
        id: `task${created.length + 1}`,
        worktreeDir: dir,
        ghRef: req.ghRef,
        createdAt: "2026-08-27T00:00:00Z",
        sessionId: "",
        closedByUser: false,
        userTitle: "",
        terminalTitle: "",
        ghTitle: req.ghTitle,
      };
      created.push(task);
      return {
        rootDir: ROOT,
        worktree: {
          path: dir,
          head: "",
          branch: "",
          isMain: false,
          gitStatuses: {},
          renameOldPaths: {},
          latestMtime: 0,
          upstream: undefined,
          tasks: [task],
        },
        dir,
        task,
        setupScript: "",
      };
    },
  };
  return { deps, created, counters };
}

function message(overrides: Partial<NewWorktreeMessage>): NewWorktreeMessage {
  return { dir: ROOT, title: "t", prompt: "p", ghRef: undefined, ...overrides };
}

const noPush: PushFn = () => {};

type Reply = { ok: boolean; dir: string; error: string };
const parse = (line: string): Reply => JSON.parse(line) as Reply;

describe("createNewWorktreeHandler", () => {
  let consoleSpy: ReturnType<typeof spyOn<Console, "error">>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("同じ参照への並行投入は 1 つだけ作り、後発は既存の場所を添えて失敗する", async () => {
    const { deps, created, counters } = createFakeDeps({ createDelayMs: 20 });
    const handle = createNewWorktreeHandler(deps);
    const msg = message({ ghRef: ghRefForIssue(42) });

    const replies = (await Promise.all([handle(msg, noPush), handle(msg, noPush)])).map(parse);

    expect(created).toHaveLength(1);
    expect(counters.maxInFlight).toBe(1);
    const ok = replies.filter((reply) => reply.ok);
    const failed = replies.filter((reply) => !reply.ok);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.dir).toBe(`${ROOT}/wt1`);
    // Expected は「既存の場所を添えて失敗する」。作成中で場所が未確定のまま失敗させない
    expect(failed[0]?.error).toBe(`Issue #42 already has a worktree at ${ROOT}/wt1`);
  });

  test("3 本以上の並行投入でも作られるのは 1 つ", async () => {
    const { deps, created } = createFakeDeps({ createDelayMs: 10 });
    const handle = createNewWorktreeHandler(deps);
    const msg = message({ ghRef: ghRefForPr(7) });

    const replies = (
      await Promise.all([handle(msg, noPush), handle(msg, noPush), handle(msg, noPush)])
    ).map(parse);

    expect(created).toHaveLength(1);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
  });

  test("repo 内のどの dir から投入しても同じ参照として直列化される", async () => {
    // 一意性の単位は main repo root + 参照。dir 文字列で鍵を作ると subdir から投入した
    // 要求が別鍵になって素通りする
    const { deps, created } = createFakeDeps({ createDelayMs: 20 });
    const handle = createNewWorktreeHandler(deps);
    const ghRef = ghRefForIssue(42);

    await Promise.all([
      handle(message({ ghRef }), noPush),
      handle(message({ dir: "/repo/sub", ghRef }), noPush),
    ]);

    expect(created).toHaveLength(1);
  });

  test("参照が違えば並行のまま走る（待ち合わせない）", async () => {
    const { deps, created, counters } = createFakeDeps({ createDelayMs: 20 });
    const handle = createNewWorktreeHandler(deps);

    await Promise.all([
      handle(message({ ghRef: ghRefForIssue(1) }), noPush),
      handle(message({ ghRef: ghRefForIssue(2) }), noPush),
      // PR と issue は番号空間を共有するので、種別違いの同番号も別鍵でなければならない
      handle(message({ ghRef: ghRefForPr(1) }), noPush),
    ]);

    expect(created).toHaveLength(3);
    // 3 本が重なって走ったことを直接見る。粒度が参照単位に閉じている証拠
    expect(counters.maxInFlight).toBe(3);
  });

  test("参照を持たない要求は待ち合わせず、何本でも作れる", async () => {
    const { deps, created } = createFakeDeps({ createDelayMs: 10 });
    const handle = createNewWorktreeHandler(deps);

    const replies = (
      await Promise.all([handle(message({}), noPush), handle(message({}), noPush)])
    ).map(parse);

    expect(created).toHaveLength(2);
    expect(replies.every((reply) => reply.ok)).toBe(true);
  });

  test("逐次に投入しても既存判定が効く", async () => {
    const { deps, created } = createFakeDeps({ createDelayMs: 0 });
    const handle = createNewWorktreeHandler(deps);
    const msg = message({ ghRef: ghRefForIssue(42) });

    expect(parse(await handle(msg, noPush)).ok).toBe(true);
    expect(parse(await handle(msg, noPush)).ok).toBe(false);
    expect(created).toHaveLength(1);
  });

  test("先行の作成が失敗しても後続は同じ参照で作れる（キューが詰まらない）", async () => {
    const { deps, created } = createFakeDeps({ createDelayMs: 0 });
    let failNext = true;
    const failing: NewWorktreeDeps = {
      ...deps,
      create: (req) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("git worktree add failed"));
        }
        return deps.create(req);
      },
    };
    const handle = createNewWorktreeHandler(failing);
    const msg = message({ ghRef: ghRefForIssue(42) });

    const [first, second] = (await Promise.all([handle(msg, noPush), handle(msg, noPush)])).map(
      parse,
    );

    expect(first?.ok).toBe(false);
    expect(second?.ok).toBe(true);
    expect(created).toHaveLength(1);
    // 失敗の観察ログは経路の契約。原因まで残っていることを固定する
    const logged = consoleSpy.mock.calls.map(([line]) => String(line));
    expect(logged).toContainEqual(
      expect.stringContaining("[handleNewWorktree] createTaskWorktree failed"),
    );
  });

  test("root を解決できない要求は逐次化に入らず失敗を返す", async () => {
    // 鍵を作れない以上、錠前を取らずに終わるのが正しい（fails closed）
    const { deps, created } = createFakeDeps({ createDelayMs: 0 });
    const handle = createNewWorktreeHandler({
      ...deps,
      resolveRoot: () => Promise.reject(new Error("not a git repo")),
    });

    const reply = parse(await handle(message({ ghRef: ghRefForIssue(42) }), noPush));

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("not a git repo");
    expect(created).toHaveLength(0);
    const logged = consoleSpy.mock.calls.map(([line]) => String(line));
    expect(logged).toContainEqual(
      expect.stringContaining("[handleNewWorktree] resolveRoot failed"),
    );
  });

  test("既存判定に失敗したら作らずに失敗を返す", async () => {
    // 判定できないまま作ると、既にある参照に 2 つ目を作る。判定不能は作成不能として扱う
    const { deps, created } = createFakeDeps({ createDelayMs: 0 });
    const handle = createNewWorktreeHandler({
      ...deps,
      findExisting: () => Promise.reject(new Error("git worktree list failed")),
    });

    const reply = parse(await handle(message({ ghRef: ghRefForIssue(42) }), noPush));

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("git worktree list failed");
    expect(created).toHaveLength(0);
    const logged = consoleSpy.mock.calls.map(([line]) => String(line));
    expect(logged).toContainEqual(
      expect.stringContaining("[handleNewWorktree] task lookup failed"),
    );
  });

  test("先行の作成を待たされたことは観察ログに残る", async () => {
    // 待ちは秒単位あり、無音だと実行者からは「固まった」としか見えない
    const { deps } = createFakeDeps({ createDelayMs: 20 });
    const handle = createNewWorktreeHandler(deps);
    const msg = message({ ghRef: ghRefForIssue(42) });

    await Promise.all([handle(msg, noPush), handle(msg, noPush)]);

    const logged = consoleSpy.mock.calls.map(([line]) => String(line));
    expect(logged).toContainEqual(
      expect.stringContaining("[handleNewWorktree] waiting for in-flight creation ref=Issue #42"),
    );
  });

  test("作成が成功したときだけ newWorktree を push する", async () => {
    const { deps } = createFakeDeps({ createDelayMs: 0 });
    const handle = createNewWorktreeHandler(deps);
    const pushed: Array<{ type: string; payload: unknown }> = [];
    const push: PushFn = (type, payload) => pushed.push({ type, payload });
    const msg = message({ ghRef: ghRefForIssue(42), prompt: "指示" });

    await handle(msg, push);
    await handle(msg, push);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.type).toBe("newWorktree");
    expect((pushed[0]?.payload as { prompt: string }).prompt).toBe("指示");
  });
});
