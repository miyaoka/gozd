// dev runner: 複数 worktree の並列 `pnpm dev` を成立させるためのリソース割当層。
// Vite port を worktree の realpath から決定論的に導出し、`GOZD_DEV_VITE_PORT` として
// renderer（vite.config.ts）と Electron（main.ts resolveRendererUrl）の両方に env で配る。
// 「port の SSOT は env」という pull 型の既存契約は変えない。concurrently の並列起動は
// 起動順序を保証しないため、bind 後の port を伝搬する push 型は採らず、起動前に両者が
// 合意できる決定論的割当にする。
//
// 決定論 + probe sweep:
// - 同じ worktree は再起動しても同じ port を得る（devtools / ブラウザの再接続が安定する）
// - hash 衝突や他プロセスの占有時は +1 ずつ最大 PORT_SWEEP 個まで空きを探す
// - probe と Vite bind の間の TOCTOU は vite.config.ts の strictPort: true が fail-fast で受ける

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";

// 16800..16999: 旧固定値 16873 を含む帯。macOS の ephemeral port（49152-65535）の外なので
// OS の自動割当とは衝突しない
const PORT_BASE = 16800;
const PORT_RANGE = 200;
const PORT_SWEEP = 16;

const repoRoot = realpathSync(resolve(import.meta.dir, ".."));

function isPortFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    // listen 失敗（EADDRINUSE 等）は bind 前なので close 不要
    server.once("error", () => done(false));
    server.once("listening", () => server.close(() => done(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function pickVitePort(): Promise<number> {
  const seed = Number.parseInt(createHash("sha256").update(repoRoot).digest("hex").slice(0, 8), 16);
  // base を帯末尾から PORT_SWEEP 分引いた範囲に丸め、probe の最大到達点（base + PORT_SWEEP - 1）
  // が宣言帯 16800..16999 を超えないようにする（帯の宣言 = 実挙動を保つ）
  const base = PORT_BASE + (seed % (PORT_RANGE - PORT_SWEEP));
  for (let i = 0; i < PORT_SWEEP; i++) {
    if (await isPortFree(base + i)) return base + i;
  }
  throw new Error(`[dev] no free port in ${base}..${base + PORT_SWEEP - 1}`);
}

const port = await pickVitePort();
console.error(`[dev] worktree=${basename(repoRoot)} vite=http://localhost:${port}`);

// bun は起動時の env snapshot を子プロセスのデフォルト継承に使うため、`process.env` への
// 代入 / delete は spawnSync の子に反映されない。必ず明示の env オブジェクトで渡す
const childEnv = { ...process.env, GOZD_DEV_VITE_PORT: String(port) };
// Electron ベースのホスト（Claude Code / VS Code 等）はターミナル環境に ELECTRON_RUN_AS_NODE=1
// を設定することがある。子の `electron .` に漏れると Electron が素の Node として起動し
// require("electron") が npm stub を返すため、spawn 前に必ず剥がす
delete childEnv.ELECTRON_RUN_AS_NODE;

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "concurrently",
    "--kill-others",
    "--names",
    "renderer,electron",
    "--prefix-colors",
    "cyan,magenta",
    "pnpm --filter @gozd/renderer dev",
    "pnpm --filter @gozd/electron dev",
  ],
  { cwd: repoRoot, stdio: "inherit", env: childEnv },
);
// spawn 自体の失敗（ENOENT 等）は result.error にしか現れず stdio inherit では透過されない
if (result.error) console.error(`[dev] spawn failed: ${result.error}`);
process.exit(result.status ?? 1);
