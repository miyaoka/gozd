import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

// main / preload は Electron が CJS で読むため cjs、renderer は browser バンドル
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "node-pty"],
});

await build({
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
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
