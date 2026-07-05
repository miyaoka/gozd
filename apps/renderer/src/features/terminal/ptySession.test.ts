// ring buffer の容量契約（チャンク数 + 総文字数の二重上限）と replay の整合を検証する。
// チャンクサイズは PTY read 単位でばらつくため、チャンク数上限だけでは総メモリが
// 実質無制限になる（issue #894）。

import { describe, expect, test } from "bun:test";
import type { PaneEntry } from "./ptySession";
import { createPtySessionManager, PTY_RING_BUFFER_MAX_CHARS } from "./ptySession";
import { terminalScrollback } from "./terminalConfig";

/** in-memory の pane registry を持つ manager を作り、leaf "leaf" を spawn 済みにする */
async function setupManager() {
  const registry = new Map<string, PaneEntry>([["leaf", { dir: "/work/repo" }]]);
  const manager = createPtySessionManager({
    panes: {
      getPane: (leafId) => registry.get(leafId),
      setSession: (leafId, session) => {
        const entry = registry.get(leafId);
        if (entry === undefined) return;
        registry.set(leafId, { ...entry, session });
      },
      iterateEntries: () => registry.entries(),
    },
    requestPtySpawn: async () => 1,
    sendPtyKill: () => {},
  });
  await manager.spawnPty("leaf", 80, 24);
  return manager;
}

/** attach して replay されたチャンク列を回収する */
function replayChunks(manager: Awaited<ReturnType<typeof setupManager>>): string[] {
  const out: string[] = [];
  const dispose = manager.attachTerminal("leaf", (data) => out.push(data));
  dispose();
  return out;
}

describe("ptySession ring buffer", () => {
  test("上限未満のチャンクは受信順にそのまま replay される", async () => {
    const manager = await setupManager();
    manager.handlePtyData(1, "a");
    manager.handlePtyData(1, "b");
    manager.handlePtyData(1, "c");
    expect(replayChunks(manager)).toEqual(["a", "b", "c"]);
  });

  test("チャンク数上限を超えると古いチャンクから破棄される", async () => {
    const manager = await setupManager();
    const overflow = 5;
    const total = terminalScrollback + overflow;
    for (let i = 0; i < total; i++) {
      manager.handlePtyData(1, `c${i}`);
    }
    const replayed = replayChunks(manager);
    expect(replayed.length).toBe(terminalScrollback);
    expect(replayed[0]).toBe(`c${overflow}`);
    expect(replayed[replayed.length - 1]).toBe(`c${total - 1}`);
  });

  test("総文字数上限を超えると古いチャンクから破棄される", async () => {
    const manager = await setupManager();
    // 3 チャンクで上限を超えるサイズ（各 3/8 上限 × 3 = 9/8 上限）
    const chunkSize = (PTY_RING_BUFFER_MAX_CHARS / 8) * 3;
    const [a, b, c] = ["a".repeat(chunkSize), "b".repeat(chunkSize), "c".repeat(chunkSize)];
    manager.handlePtyData(1, a);
    manager.handlePtyData(1, b);
    manager.handlePtyData(1, c);
    const replayed = replayChunks(manager);
    expect(replayed.length).toBe(2);
    expect(replayed[0]).toBe(b);
    expect(replayed[1]).toBe(c);
  });

  test("単体で上限を超えるチャンクでも直近 1 個は必ず残す", async () => {
    const manager = await setupManager();
    const big = "x".repeat(PTY_RING_BUFFER_MAX_CHARS + 1);
    manager.handlePtyData(1, big);
    expect(replayChunks(manager)).toEqual([big]);

    // 次のチャンクが来たら上限超過分（big）は破棄される
    manager.handlePtyData(1, "y");
    expect(replayChunks(manager)).toEqual(["y"]);
  });
});
