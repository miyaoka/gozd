import { describe, expect, test } from "bun:test";
import {
  createGitAdmission,
  currentGitTier,
  type GitBudget,
  type GitTier,
  withGitTier,
} from "./gitAdmission";

const LIMITS = { generalCap: 2, interactiveHeadroom: 1, networkCap: 1 };

/** 外から完了させられる task。開始されたかどうかを started で観測する */
function controllableTask() {
  let finish: (ok: boolean) => void = () => {};
  const state = { started: false };
  const task = () => {
    state.started = true;
    return new Promise<string>((resolve, reject) => {
      finish = (ok) => (ok ? resolve("done") : reject(new Error("failed")));
    });
  };
  return { task, state, finish: (ok = true) => finish(ok) };
}

/** microtask を流して、待機列の再評価を反映させる */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createGitAdmission", () => {
  function start(
    admission: ReturnType<typeof createGitAdmission>,
    budget: GitBudget,
    tier: GitTier,
  ) {
    const t = controllableTask();
    const done = admission.run(budget, tier, t.task);
    return { ...t, done };
  }

  test("background は generalCap を超えて同時に走らない", async () => {
    const admission = createGitAdmission(LIMITS);
    const tasks = [0, 1, 2].map(() => start(admission, "general", "background"));
    await flush();
    expect(tasks.map((t) => t.state.started)).toEqual([true, true, false]);

    tasks[0].finish();
    await flush();
    expect(tasks[2].state.started).toBe(true);
  });

  test("background が上限まで埋まっていても interactive は予備枠で走る", async () => {
    const admission = createGitAdmission(LIMITS);
    [0, 1].forEach(() => start(admission, "general", "background"));
    const interactive = start(admission, "general", "interactive");
    await flush();
    expect(interactive.state.started).toBe(true);
  });

  test("枠が空いたら、先に並んだ background より後から来た interactive を先に通す", async () => {
    const admission = createGitAdmission(LIMITS);
    const running = [0, 1, 2].map((i) =>
      start(admission, "general", i < 2 ? "background" : "interactive"),
    );
    const queuedBackground = start(admission, "general", "background");
    const queuedInteractive = start(admission, "general", "interactive");
    await flush();
    expect(queuedBackground.state.started).toBe(false);
    expect(queuedInteractive.state.started).toBe(false);

    running[2].finish();
    await flush();
    expect(queuedInteractive.state.started).toBe(true);
    expect(queuedBackground.state.started).toBe(false);
  });

  test("network は general と別の予算で数える", async () => {
    const admission = createGitAdmission(LIMITS);
    [0, 1].forEach(() => start(admission, "general", "background"));
    const network = start(admission, "network", "background");
    const queuedNetwork = start(admission, "network", "interactive");
    await flush();
    expect(network.state.started).toBe(true);
    expect(queuedNetwork.state.started).toBe(false);
  });

  test("task が失敗しても枠を返し、失敗は呼び出し元に伝わる", async () => {
    const admission = createGitAdmission(LIMITS);
    const tasks = [0, 1, 2].map(() => start(admission, "general", "background"));
    await flush();

    tasks[0].finish(false);
    expect(tasks[0].done).rejects.toThrow("failed");
    await flush();
    expect(tasks[2].state.started).toBe(true);
  });
});

describe("withGitTier", () => {
  test("指定の無い経路は interactive", () => {
    expect(currentGitTier()).toBe("interactive");
  });

  test("await をまたいでも tier が伝播する", async () => {
    const observed = await withGitTier("background", async () => {
      await flush();
      return currentGitTier();
    });
    expect(observed).toBe("background");
    expect(currentGitTier()).toBe("interactive");
  });
});
