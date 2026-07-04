// electron-builder の `electronDist`（pnpm 展開済みの Electron dist）の実在を保証する。
//
// pnpm の fresh install は electron の postinstall（zip ダウンロード + dist 展開）を
// 実行しないことがあり（store から復元される builds 済み扱いのパッケージは build script が
// 再実行されない）、その状態で electron-builder を走らせると electronDist 不在で即死する。
// build:app の入口で不在時のみ electron 同梱の install script を実行して dist を展開する
// （zip は ~/Library/Caches/electron にキャッシュされるため 2 回目以降は展開のみ）。
//
// パッケージ位置は resolve で引く。electron-builder.yml の `electronDist` は静的 YAML の
// ため repo root 相対（`../../node_modules/electron/dist`）を固定で書いており、
// nodeLinker: hoisted（workspace 全体で electron 単一バージョン = root hoist）がその
// 前提を保証する。resolve 結果が前提とずれた場合はここで気づけるようログに残す。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const electronDir = dirname(Bun.resolveSync("electron/package.json", import.meta.dir));
const dist = join(electronDir, "dist");

if (existsSync(dist)) {
  process.exit(0);
}

console.error(`[ensureElectronDist] dist not found; running electron install script: ${dist}`);
execFileSync("bun", [join(electronDir, "install.js")], { stdio: "inherit" });

if (!existsSync(dist)) {
  console.error(`[ensureElectronDist] install script finished but dist is still missing: ${dist}`);
  process.exit(1);
}
