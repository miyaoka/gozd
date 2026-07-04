// gozd-cli の TS 実装エントリ。Swift 版 `GozdCLI/main.swift` の置き換え
// （issue #895「CLI: ソケットプロトコル互換を保って TS で再実装」）。
//
// 実行形態: esbuild で dist/cli.cjs に bundle し、`bin/gozd-cli` shim が起動する。
//   - dev: `node dist/cli.cjs`
//   - packaged: `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/Gozd dist/cli.cjs`
//     （同梱 Electron バイナリを Node として使う = ユーザー環境に Node を要求しない）
//
// サブコマンド（Swift 版と同一契約）:
//   gozd-cli [path] / open [path]  … OpenMessage 送信（GOZD_COLD_START で launch request 書き出し）
//   gozd-cli hook <event>          … stdin JSON を HookMessage に詰めて送信
//   gozd-cli --help                … usage

import type { ClientMessage } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildHookMessage, parseStdinJson, resolveSocketPath, writeLaunchRequest } from "./cli/cliOps";
import { sendClientMessage } from "./cli/socketClient";

const USAGE = `gozd - Git Orchestrated Zone for Development

Usage:
  gozd [path]        Open the given path (default: cwd) in the gozd app
  gozd open [path]   Same as above (explicit subcommand form)
  gozd hook <event>  Send a Claude Code hook event (reads JSON from stdin)
  gozd --help        Print this help

Environment:
  GOZD_SOCKET_PATH  Override Unix socket path (default: $TMPDIR/gozd-{channel}.sock)
  GOZD_PTY_ID       Used by \`hook\` to attribute the event to a PTY
  GOZD_COLD_START   If set, \`open\` writes a launch request file instead of socket send
`;

async function sendOrExit(message: ClientMessage): Promise<void> {
  const socketPath = resolveSocketPath(process.env);
  const result = await tryCatch(sendClientMessage(socketPath, message));
  if (!result.ok) {
    process.stderr.write(`Failed to send message to gozd: ${result.error}\n`);
    process.exit(1);
  }
}

async function openCommand(target: string): Promise<void> {
  const absolute = resolve(process.cwd(), target);

  // cold start: socket が無い前提で launch request ファイルを書き出す
  // （bin/gozd シェルラッパーがアプリ未起動時にこの経路を取らせる）
  if (process.env.GOZD_COLD_START !== undefined) {
    const written = tryCatch(() => writeLaunchRequest(absolute, resolveSocketPath(process.env)));
    if (!written.ok) {
      process.stderr.write(`Failed to write launch request: ${written.error}\n`);
      process.exit(1);
    }
    return;
  }

  await sendOrExit({ open: { targetPath: absolute } });
}

async function hookCommand(event: string): Promise<void> {
  // stdin から Claude Code が渡す JSON を読む（空でも可）
  const stdinText = tryCatch(() => readFileSync(0, "utf8"));
  const stdinJson = parseStdinJson(stdinText.ok ? stdinText.value : "");
  const hook = buildHookMessage(event, stdinJson, process.env);
  await sendOrExit({ hook });
}

async function main(): Promise<void> {
  const [first, second] = process.argv.slice(2);

  if (first === undefined) {
    await openCommand(".");
    return;
  }
  if (first === "open") {
    await openCommand(second ?? ".");
    return;
  }
  if (first === "hook") {
    if (second === undefined || second === "") {
      process.stderr.write("hook requires an event name\n");
      process.exit(1);
    }
    await hookCommand(second);
    return;
  }
  if (first.startsWith("-")) {
    process.stdout.write(USAGE);
    return;
  }
  // `hook` / `open` / `--*` 以外の先頭引数は open のパスとみなす（Swift 版と同じ）
  await openCommand(first);
}

void main();
