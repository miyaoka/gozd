// socketMessages（ClientMessage 解釈 + 配送）のテスト。
// applyClaudeSessionHook の taskStore 書き込み経路は taskStore.test.ts が意味論を固定して
// いるため、ここでは routing（hook push の payload 形 / open の gozdOpen 変換 / decode
// 失敗の観察 / 逐次処理）を mock push で検証する。
// 未登録 ptyId の session-start は worktreePath 空ガードで skip される（実 store に
// 書き込まない）ことを前提に、production の taskStore を import したまま実行できる。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocketMessageHandler } from "./socketMessages";

describe("socketMessages", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("hook メッセージは Swift onHook と同形の payload で push される", async () => {
    const pushed: Array<{ type: string; payload: unknown }> = [];
    const handle = createSocketMessageHandler((type, payload) => pushed.push({ type, payload }));
    await handle('{"hook":{"event":"running","ptyId":3}}');
    expect(pushed[0]?.type).toBe("hook");
    expect(pushed[0]?.payload).toEqual({
      event: "running",
      ptyId: 3,
      sessionId: "",
      lastAssistantMessage: "",
      toolName: "",
      toolInput: "",
      pendingWork: false,
      hasTeammateTask: false,
      agentId: "",
      teammateName: "",
    });
  });

  test("hook の型違反フィールドは default に倒して push は届く（lenient。message 破棄しない）", async () => {
    const pushed: Array<{ type: string; payload: unknown }> = [];
    const handle = createSocketMessageHandler((type, payload) => pushed.push({ type, payload }));
    await handle('{"hook":{"event":"running","ptyId":"3","pendingWork":"yes"}}');
    expect(pushed[0]?.payload).toEqual({
      event: "running",
      ptyId: 0,
      sessionId: "",
      lastAssistantMessage: "",
      toolName: "",
      toolInput: "",
      pendingWork: false,
      hasTeammateTask: false,
      agentId: "",
      teammateName: "",
    });
  });

  test("未登録 ptyId の session-start は skip されつつ hook push 自体は届く", async () => {
    const pushed: Array<{ type: string; payload: unknown }> = [];
    const handle = createSocketMessageHandler((type, payload) => pushed.push({ type, payload }));
    await handle(
      '{"hook":{"event":"session-start","ptyId":999999,"sessionId":"00000000-0000-0000-0000-000000000001"}}',
    );
    expect(pushed[0]?.type).toBe("hook");
    const payload = pushed[0]?.payload as { sessionId: string };
    expect(payload.sessionId).toBe("00000000-0000-0000-0000-000000000001");
  });

  test("open メッセージは gozdOpen payload に変換して push される", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-socket-open-test-"));
    tempDirs.push(dir);
    const pushed: Array<{ type: string; payload: unknown }> = [];
    const handle = createSocketMessageHandler((type, payload) => pushed.push({ type, payload }));
    await handle(JSON.stringify({ open: { targetPath: dir } }));
    expect(pushed[0]?.type).toBe("gozdOpen");
    const payload = pushed[0]?.payload as Record<string, unknown>;
    expect(payload.isGitRepo).toBe(false);
    expect(payload.channel).toBe("");
    expect(payload.switchToDir).toBe("");
  });

  test("open メッセージの不在パスは gozdOpen を push しない（観察ログのみ）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-socket-open-notexist-"));
    tempDirs.push(dir);
    const pushed: unknown[] = [];
    const handle = createSocketMessageHandler((type) => pushed.push(type));
    await handle(JSON.stringify({ open: { targetPath: join(dir, "notexist") } }));
    // 後続 hook の到達で「gozdOpen が飛んでいない」ことを固定する
    await handle('{"hook":{"event":"running","ptyId":1}}');
    expect(pushed).toEqual(["hook"]);
  });

  test("newWorktree は dir 未指定を失敗として応答する（応答を返す唯一の種別）", async () => {
    const handle = createSocketMessageHandler(() => {});
    const reply = await handle(JSON.stringify({ newWorktree: { title: "t", prefill: "" } }));
    expect(JSON.parse(reply ?? "")).toEqual({
      ok: false,
      dir: "",
      error: "newWorktree: dir is required",
    });
  });

  test("newWorktree は作成に失敗したら push せず失敗を応答する", async () => {
    // git 管理外の dir では起点 ref を解決できない。worktree だけ出来て task が付かない
    // 中間状態を作らないため、この時点で止めて実行者に失敗を返す
    const dir = mkdtempSync(join(tmpdir(), "gozd-socket-newwt-"));
    tempDirs.push(dir);
    const pushed: unknown[] = [];
    const handle = createSocketMessageHandler((type) => pushed.push(type));
    const reply = await handle(JSON.stringify({ newWorktree: { dir, title: "t", prefill: "" } }));
    const parsed = JSON.parse(reply ?? "") as { ok: boolean; dir: string; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).not.toBe("");
    expect(pushed).toEqual([]);
  });

  test("JSON として壊れた行は push せずに落とす（観察ログのみ）", async () => {
    const pushed: unknown[] = [];
    const handle = createSocketMessageHandler((type) => pushed.push(type));
    await handle("{ broken");
    await handle('{"hook":{"event":"running","ptyId":1}}');
    expect(pushed).toEqual(["hook"]);
  });

  test("複数行は submit 順に逐次処理される", async () => {
    const pushed: Array<{ event: string }> = [];
    // done イベントは観測用の debugLog push も飛ぶため、順序検証対象の hook push だけ拾う
    const handle = createSocketMessageHandler((type, payload) => {
      if (type !== "hook") return;
      pushed.push(payload as { event: string });
    });
    // 完了を待たずに 3 行 submit し、逐次キューが submit 順を保つことを固定する
    void handle('{"hook":{"event":"running","ptyId":1}}');
    void handle('{"hook":{"event":"tool-done","ptyId":1}}');
    await handle('{"hook":{"event":"done","ptyId":1}}');
    expect(pushed.map((p) => p.event)).toEqual(["running", "tool-done", "done"]);
  });

  test("処理が reject する行が混ざっても後続行は処理される（chain 汚染防止）", async () => {
    // 逐次キューの終端 catch が無いと、1 度の reject で chain が rejected のまま残り
    // 以降の全メッセージが恒久 drop される。push が throw する行で reject を再現し、
    // 後続行が届くことを固定する
    const pushed: Array<{ event: string }> = [];
    const handle = createSocketMessageHandler((_type, payload) => {
      const p = payload as { event: string };
      if (p.event === "poison") throw new Error("push failed");
      pushed.push(p);
    });
    void handle('{"hook":{"event":"poison","ptyId":1}}');
    await handle('{"hook":{"event":"running","ptyId":1}}');
    expect(pushed.map((p) => p.event)).toEqual(["running"]);
  });
});
