import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

// main / preload / cli は Electron / Node が CJS で読むため cjs、renderer は browser バンドル
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  // @parcel/watcher は .node ネイティブバイナリを実行時解決するため bundle できない
  external: ["electron", "node-pty", "@parcel/watcher"],
});

await build({
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

// gozd-cli（TS 再実装）。bin/gozd-cli shim が node / ELECTRON_RUN_AS_NODE で実行する
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
});

await build({
  entryPoints: ["src/renderer/main.ts"],
  outdir: "dist/renderer",
  bundle: true,
  platform: "browser",
  format: "iife",
});

mkdirSync("dist/renderer", { recursive: true });
copyFileSync("src/renderer/index.html", "dist/renderer/index.html");
