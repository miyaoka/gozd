// portScanner の帰属・差分 push・失敗 skip の契約テスト。
// Swift 版 PortScanner の意味論（live / orphaned / external、失敗スキャンは前回
// snapshot 維持、差分時のみ push）を deps 注入で固定する。

import { describe, expect, test } from "bun:test";
import type { ListenProcess } from "./serverList";
import { createPortScanner, type PtyOwner, type ScannedServer } from "./portScanner";

interface Harness {
  scanner: ReturnType<typeof createPortScanner>;
  pushes: ScannedServer[][];
  setListens: (value: ListenProcess[] | undefined) => void;
  setParents: (value: Map<number, number> | undefined) => void;
  setOwners: (value: Map<number, PtyOwner>) => void;
}

function makeHarness(): Harness {
  let listens: ListenProcess[] | undefined = [];
  let parents: Map<number, number> | undefined = new Map();
  let owners = new Map<number, PtyOwner>();
  const pushes: ScannedServer[][] = [];
  const scanner = createPortScanner({
    listListenProcesses: () => Promise.resolve(listens),
    listProcParents: () => Promise.resolve(parents),
    ptyOwners: () => owners,
    onSnapshot: (servers) => pushes.push(servers),
  });
  return {
    scanner,
    pushes,
    setListens: (value) => {
      listens = value;
    },
    setParents: (value) => {
      parents = value;
    },
    setOwners: (value) => {
      owners = value;
    },
  };
}

describe("portScanner", () => {
  test("ppid チェーンで PTY 子孫を live 帰属する", async () => {
    const h = makeHarness();
    // shell(10) → npm(20) → node(30, LISTEN)
    h.setOwners(new Map([[10, { ptyId: 7, worktreePath: "/wt/a" }]]));
    h.setParents(
      new Map([
        [30, 20],
        [20, 10],
        [10, 1],
      ]),
    );
    h.setListens([{ pid: 30, name: "node", ports: [3000] }]);
    await h.scanner.scanOnce();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]?.[0]).toEqual({
      pid: 30,
      name: "node",
      ports: [3000],
      attribution: "live",
      worktreePath: "/wt/a",
      ptyId: 7,
    });
  });

  test("PTY 消滅後は orphaned として worktree を記憶し続ける", async () => {
    const h = makeHarness();
    h.setOwners(new Map([[10, { ptyId: 7, worktreePath: "/wt/a" }]]));
    h.setParents(
      new Map([
        [30, 10],
        [10, 1],
      ]),
    );
    h.setListens([{ pid: 30, name: "node", ports: [3000] }]);
    await h.scanner.scanOnce();

    // PTY を閉じた（owners から消えたが node は port を掴んだまま）
    h.setOwners(new Map());
    h.setParents(new Map([[30, 1]]));
    await h.scanner.scanOnce();
    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1]?.[0]).toMatchObject({
      attribution: "orphaned",
      worktreePath: "/wt/a",
      ptyId: 0,
    });
  });

  test("gozd 外プロセスは external", async () => {
    const h = makeHarness();
    h.setParents(new Map([[40, 1]]));
    h.setListens([{ pid: 40, name: "postgres", ports: [5432] }]);
    await h.scanner.scanOnce();
    expect(h.pushes[0]?.[0]).toMatchObject({ attribution: "external", worktreePath: "", ptyId: 0 });
  });

  test("差分が無ければ push しない（正当な 0 件は初回のみ push）", async () => {
    const h = makeHarness();
    await h.scanner.scanOnce();
    await h.scanner.scanOnce();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toEqual([]);
  });

  test("列挙失敗のスキャンは skip して前回 snapshot を維持する", async () => {
    const h = makeHarness();
    h.setParents(new Map([[40, 1]]));
    h.setListens([{ pid: 40, name: "node", ports: [8080] }]);
    await h.scanner.scanOnce();

    // lsof 失敗 → 「0 件」誤 push で全バッジが消えてはいけない
    h.setListens(undefined);
    await h.scanner.scanOnce();
    expect(h.pushes).toHaveLength(1);
    expect(h.scanner.current()).toHaveLength(1);

    // ps 失敗も同様（誤帰属 push を防ぐ）
    h.setListens([]);
    h.setParents(undefined);
    await h.scanner.scanOnce();
    expect(h.pushes).toHaveLength(1);
  });

  test("port 昇順 → pid 昇順で安定ソートする", async () => {
    const h = makeHarness();
    h.setParents(
      new Map([
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    );
    h.setListens([
      { pid: 3, name: "c", ports: [9000] },
      { pid: 2, name: "b", ports: [3000] },
      { pid: 1, name: "a", ports: [3000] },
    ]);
    await h.scanner.scanOnce();
    expect(h.pushes[0]?.map((s) => s.pid)).toEqual([1, 2, 3]);
  });

  test("消滅した pid の orphaned 記憶は掃除される", async () => {
    const h = makeHarness();
    h.setOwners(new Map([[10, { ptyId: 7, worktreePath: "/wt/a" }]]));
    h.setParents(
      new Map([
        [30, 10],
        [10, 1],
      ]),
    );
    h.setListens([{ pid: 30, name: "node", ports: [3000] }]);
    await h.scanner.scanOnce();

    // node 自体も消滅 → 記憶が掃除され、pid 30 再利用時に orphaned 誤判定しない
    h.setOwners(new Map());
    h.setParents(new Map());
    h.setListens([]);
    await h.scanner.scanOnce();

    h.setParents(new Map([[30, 1]]));
    h.setListens([{ pid: 30, name: "other", ports: [4000] }]);
    await h.scanner.scanOnce();
    expect(h.pushes[2]?.[0]).toMatchObject({ attribution: "external" });
  });
});
