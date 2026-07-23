// rg 実行バイナリのパス解決。VS Code `base/node/ripgrep.ts` / `@vscode/ripgrep` 相当。
//
// @vscode/ripgrep は rg 実体を per-platform パッケージ（`@vscode/ripgrep-<platform>-<arch>`）に
// 持ち、optionalDependencies で現在プラットフォームの 1 つだけが install される。よって
// `@vscode/ripgrep-${process.platform}-${process.arch}/bin/rg` を動的に require.resolve する
// （@vscode/ripgrep 本体の lib/index.js と同じ解決）。ハードコードすると CI（別プラットフォーム）で
// 当該パッケージが無く resolve 失敗する。
//
// packaged .app では require.resolve が app.asar 内のパスを返すが、asar 内バイナリは
// exec 不可のため app.asar.unpacked 側へ差し替える（node-pty / .node と同じ規律。
// asarUnpack で unpacked にコピー済み）。

import { createRequire } from "node:module";

const localRequire = createRequire(__filename);

let cached: string | undefined;

export function rgDiskPath(): string {
  if (cached !== undefined) return cached;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  const resolved = localRequire.resolve(`${platformPkg}/bin/${binaryName}`);
  cached = resolved.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  return cached;
}
