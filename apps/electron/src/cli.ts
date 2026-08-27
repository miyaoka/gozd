// gozd-cli の TS 実装エントリ。Swift 版 `GozdCLI/main.swift` の置き換え
// （issue #895「CLI: ソケットプロトコル互換を保って TS で再実装」）。
//
// 実行形態: esbuild で dist/cli.cjs に bundle し、`bin/gozd-cli` shim が起動する。
//   - dev: `node dist/cli.cjs`
//   - packaged: `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/Gozd dist/cli.cjs`
//     （同梱 Electron バイナリを Node として使う = ユーザー環境に Node を要求しない）
//
// サブコマンド:
//   gozd-cli [path] / open [path]  … OpenMessage 送信（GOZD_COLD_START で launch request 書き出し）
//   gozd-cli hook <event>          … stdin JSON を HookMessage に詰めて送信
//   gozd-cli worktree new …        … NewWorktreeMessage 送信。応答を待って結果を返す
//   gozd-cli --help                … usage
//
// open / hook は Swift 版と同一契約。worktree は TS 版で足したもので、旧版の CLI は
// 先頭引数 `worktree` を open のパスとみなす（未知の先頭引数 = パス扱いのため）。

import type { ClientMessage } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildHookMessage,
  parseNewWorktreeArgs,
  parseStdinJson,
  resolveSocketPath,
  writeLaunchRequest,
} from "./cli/cliOps";
import { requestClientReply, sendClientMessage } from "./cli/socketClient";

const USAGE = `gozd - Git Orchestrated Zone for Development

Usage:
  gozd [path]           Open the given path (default: cwd) in the gozd app
  gozd open [path]      Same as above (explicit subcommand form)
  gozd worktree new     Create a worktree, then start claude in it
                        (see \`gozd worktree --help\`)
  gozd hook <event>     Send a Claude Code hook event (reads JSON from stdin)
  gozd --help           Print this help

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

  // 存在しないパスはここで fail fast する。socket は一方向 NDJSON で main 側で弾いても
  // ターミナルに何も返せないため、実行者にエラーを伝えられるのは送信前のこの位置だけ。
  // gozd には新規ファイル編集機能がなく、存在しないパスを受けても実現手段がない
  // （通すとサイドバーに幽霊 repo が登録され fs watch が恒久的に失敗し続ける）
  if (!existsSync(absolute)) {
    process.stderr.write(`gozd: path does not exist: ${absolute}\n`);
    process.exit(1);
  }

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

const WORKTREE_USAGE = `gozd worktree - manage gozd worktrees

Usage:
  gozd worktree new [options]   Create a worktree, then start claude in it

Options:
  --title <text>     Name shown for the worktree in gozd (required)
  --prompt <text>    Prompt passed to claude on launch (runs immediately)
  --issue <number>   Associate the worktree with a GitHub issue
  --pr <number>      Associate the worktree with a GitHub pull request
  --dir <path>       Repository to create the worktree in (default: cwd)

Prints the created worktree path to stdout. Requires a running gozd window:
the request goes to the socket at $GOZD_SOCKET_PATH.
`;

/**
 * `gozd worktree new` — 作業スペースを 1 つ増やし、そこで claude を起動する。
 *
 * UI の「New Worktree」/ PR・issue picker と同じ合成操作をエージェントから駆動する入口。
 * 成功時は作成した worktree の絶対パスを stdout に 1 行返す（呼び出し側がそのまま次の
 * コマンドの cwd に使える）。gozd 側で作れなかった場合は非 0 で終了する。
 */
async function worktreeCommand(argv: string[]): Promise<void> {
  // help はサブコマンドの前後どちらに置かれても効かせる。使い方を尋ねる要求を
  // 「不明なオプション」で弾くと、呼び出し側は正しい形を知る手段を失う
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(WORKTREE_USAGE);
    return;
  }
  const [sub, ...rest] = argv;
  if (sub !== "new") {
    process.stderr.write(`gozd worktree: unknown subcommand: ${sub ?? "(none)"}\n\n`);
    process.stderr.write(WORKTREE_USAGE);
    process.exit(1);
  }
  const parsed = parseNewWorktreeArgs(rest, process.cwd());
  if (!parsed.ok) {
    process.stderr.write(`gozd worktree new: ${parsed.error}\n\n`);
    process.stderr.write(WORKTREE_USAGE);
    process.exit(1);
  }
  const socketPath = resolveSocketPath(process.env);
  const sent = await tryCatch(requestClientReply(socketPath, { newWorktree: parsed.value }));
  if (!sent.ok) {
    process.stderr.write(`Failed to send message to gozd: ${sent.error}\n`);
    process.exit(1);
  }
  if (!sent.value.ok) {
    process.stderr.write(`gozd worktree new: ${sent.value.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${sent.value.dir}\n`);
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
  if (first === "worktree") {
    await worktreeCommand(process.argv.slice(3));
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
