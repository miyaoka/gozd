import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { docBlockPlugin } from "@miyaoka/vite-plugin-doc-block";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

// material-icon-theme の SVG を import.meta.glob で列挙するための alias。
// nodeLinker: hoisted ではパッケージ実体が repo root の node_modules に置かれ、
// Vite root (apps/renderer) 基準の "/node_modules/..." glob ではマッチしない。
// Node の module resolution を SSOT に実体ディレクトリを解決し、配置方式に依存させない。
const require = createRequire(import.meta.url);
const materialIconsDir = join(
  dirname(require.resolve("material-icon-theme/package.json")),
  "icons",
);

// dev server port は env `GOZD_DEV_VITE_PORT` を SSOT として受け取る。値は root の dev runner
// (`scripts/dev.ts`) が worktree の realpath から決定論的に導出して設定する（複数 worktree の
// 並列 `pnpm dev` 対応）。Electron main (`resolveRendererUrl`) も同じ env を読むため、両者は
// 起動順序に依存せず同じ port で合意する。dev URL の scheme + host は `http://localhost` 固定の
// 契約。env なし時は port 未指定 (Vite default) に倒し config load 自体は通す (knip 等の静的解析
// が `vite.config.ts` を invoke する経路を壊さないため)。env 強制は dev runner の責務に集約する。
//
// strictPort: true により、port 占有時 (runner の probe と bind の間の TOCTOU / 別 Vite アプリ
// との衝突) は即時 fail させる。fallback すると固定 env を読む Electron が先発の Vite に繋がって
// 「別 worktree のはずなのに先発の内容が表示される」事故になる。

export default defineConfig(() => {
  const portEnv = process.env.GOZD_DEV_VITE_PORT;
  return {
    // Icons の scale: 1 は icon svg を 1em 基準にする (default は 1.2em)。
    // font-size でサイズ指定している icon (text-xs 等) は 1em 基準が前提
    plugins: [docBlockPlugin(), tailwindcss(), vue(), Icons({ compiler: "vue3", scale: 1 })],
    base: "./",
    resolve: {
      alias: {
        // "$" 始まりは実 fs パスへの alias の慣習 (SvelteKit $lib と同型)。"~" は
        // unplugin-icons の virtual module (~icons/) と紛れるため使わない
        "$material-icons": materialIconsDir,
      },
    },
    server: {
      port: portEnv !== undefined && portEnv !== "" ? Number(portEnv) : undefined,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      // material-icon-theme の SVG（1200+個）がインライン化されて JS が肥大化するのを防ぐ
      assetsInlineLimit: 0,
    },
  };
});
