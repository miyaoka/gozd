// buildPtyEnv のテスト。Swift 版 `GozdEnvOverlayTests.swift` のケースを対で移植し、
// 3 層 merge（親 env → renderer env → gozd overlay）と ZDOTDIR チェーンの契約を固定する。
// buildPtyEnv は process.env を base に読むため、テストは process.env に一時キーを
// 立てて相対的な挙動を検証する。

import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { buildPtyEnv, claudeSettingsPath, cliPath, socketPath, zdotdir } from "./gozdEnv";

describe("buildPtyEnv", () => {
  const touchedKeys: string[] = [];

  function setParentEnv(key: string, value: string): void {
    process.env[key] = value;
    touchedKeys.push(key);
  }

  afterEach(() => {
    for (const key of touchedKeys.splice(0)) {
      delete process.env[key];
    }
  });

  test("ptyId と固定 GOZD_* 変数が注入される", () => {
    const env = buildPtyEnv({}, 7);
    expect(env.GOZD_PTY_ID).toBe("7");
    expect(env.GOZD_SOCKET_PATH).toBe(socketPath);
    expect(env.GOZD_CLI_PATH).toBe(cliPath);
    expect(env.GOZD_CLAUDE_SETTINGS_PATH).toBe(claudeSettingsPath);
  });

  test("ZDOTDIR は gozd 側に切替、ユーザーの ZDOTDIR は GOZD_ORIG_ZDOTDIR に退避される", () => {
    const env = buildPtyEnv({ ZDOTDIR: "/Users/foo/.config/zsh" }, 1);
    expect(env.ZDOTDIR).toBe(zdotdir);
    expect(env.GOZD_ZDOTDIR).toBe(zdotdir);
    expect(env.GOZD_ORIG_ZDOTDIR).toBe("/Users/foo/.config/zsh");
  });

  test("入力 env に ZDOTDIR が無ければ userHome をフォールバックに退避する", () => {
    // 親 process.env に ZDOTDIR が無い前提（あるなら本ケースは親値退避の検証になるため skip 相当）
    if (process.env.ZDOTDIR !== undefined) return;
    const env = buildPtyEnv({}, 1);
    expect(env.GOZD_ORIG_ZDOTDIR).toBe(homedir());
  });

  test("renderer 側で渡された値は親 env / overlay デフォルトより優先される", () => {
    setParentEnv("GOZD_TEST_PARENT_KEY", "parent");
    const env = buildPtyEnv({ GOZD_TEST_PARENT_KEY: "renderer", TERM_PROGRAM: "vscode" }, 1);
    expect(env.GOZD_TEST_PARENT_KEY).toBe("renderer");
    expect(env.TERM_PROGRAM).toBe("vscode");
  });

  test("TERM_PROGRAM / FORCE_HYPERLINK は未設定時に gozd デフォルトで埋まる", () => {
    const env = buildPtyEnv({}, 1);
    expect(env.TERM_PROGRAM).toBe(process.env.TERM_PROGRAM ?? "gozd");
    expect(env.FORCE_HYPERLINK).toBe(process.env.FORCE_HYPERLINK ?? "1");
  });

  test("親プロセスの env が base として継承される", () => {
    setParentEnv("GOZD_TEST_INHERIT_KEY", "inherited");
    const env = buildPtyEnv({}, 1);
    expect(env.GOZD_TEST_INHERIT_KEY).toBe("inherited");
  });

  test("stripped keys（GOZD_DEV_PROJECT_ROOT 等）は子に継承されない", () => {
    setParentEnv("GOZD_DEV_PROJECT_ROOT", "/some/repo");
    setParentEnv("GOZD_DEV_VITE_PORT", "16873");
    setParentEnv("GOZD_ELECTRON_RENDERER_URL", "http://localhost:17873");
    const env = buildPtyEnv({}, 1);
    expect(env.GOZD_DEV_PROJECT_ROOT).toBeUndefined();
    expect(env.GOZD_DEV_VITE_PORT).toBeUndefined();
    expect(env.GOZD_ELECTRON_RENDERER_URL).toBeUndefined();
  });
});
