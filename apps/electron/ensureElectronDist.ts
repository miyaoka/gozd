// electron-builder の `electronDist`（pnpm 展開済みの Electron dist）の実在を保証する。
//
// pnpm の fresh install は electron の postinstall（zip ダウンロード + dist 展開）を
// 実行しないことがあり（store から復元される builds 済み扱いのパッケージは build script が
// 再実行されない）、その状態で electron-builder を走らせると electronDist 不在で即死する。
// build:app の入口で不在時のみ electron 同梱の install script を実行して dist を展開する
// （zip は ~/Library/Caches/electron にキャッシュされるため 2 回目以降は展開のみ）。
//
// パスは electron-builder.yml の `electronDist`（projectDir 相対の
// `../../node_modules/electron/dist`）と同一の導出で固定する。module 解決
// （require.resolve 系）で引くと、旧 install の残骸（apps/electron/node_modules/electron）
// を拾って「guard は通るが electron-builder は空の root を読む」乖離が起きうるため、
// guard と consumer は単一のパス定義を共有する。root 単一配置は nodeLinker: hoisted
// （workspace 全体で electron 単一バージョン）が保証する前提で、崩れたら明示エラーで落とす。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const electronDir = join(import.meta.dir, "..", "..", "node_modules", "electron");
const dist = join(electronDir, "dist");

if (existsSync(dist)) {
  process.exit(0);
}

if (!existsSync(join(electronDir, "install.js"))) {
  console.error(
    `[ensureElectronDist] electron package not found at ${electronDir} (nodeLinker: hoisted の root 単一配置前提が崩れている)`,
  );
  process.exit(1);
}

console.error(`[ensureElectronDist] dist not found; running electron install script: ${dist}`);
execFileSync("bun", [join(electronDir, "install.js")], { stdio: "inherit" });

if (!existsSync(dist)) {
  console.error(`[ensureElectronDist] install script finished but dist is still missing: ${dist}`);
  process.exit(1);
}
