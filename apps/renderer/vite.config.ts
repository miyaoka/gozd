import { docBlockPlugin } from "@miyaoka/vite-plugin-doc-block";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

// dev server port は env `GOZD_DEV_VITE_PORT` (root の `pnpm dev` script で設定) を SSOT として
// 受け取る。Swift 側 (`RpcSchemeHandler` の Origin allowlist / `ExternalLinkNavigationDecider` の
// dev origin 判定 / `GozdApp` の `page.load`) も同じ env を読むため、port を変えるときは root
// `package.json` の dev script 1 箇所だけ書き換えればよい。dev URL の scheme + host は
// `http://localhost` 固定の契約。env なし時は port 未指定 (Vite default) に倒し config load 自体は
// 通す (knip 等の静的解析が `vite.config.ts` を invoke する経路を壊さないため)。env 強制は
// root `pnpm dev` script の責務に集約する。
//
// strictPort: true により、二重 `pnpm dev` / 別 Vite アプリと衝突したら即時 fail させる。
// fallback すると Swift `.app` の dev port は固定なので先発の Vite に繋がって「別 worktree の
// はずなのに先発の内容が表示される」事故になる。

export default defineConfig(() => {
  const portEnv = process.env.GOZD_DEV_VITE_PORT;
  return {
    // Icons の scale: 1 は icon svg を 1em 基準にする (default は 1.2em)。
    // font-size でサイズ指定している icon (text-xs 等) は 1em 基準が前提
    plugins: [docBlockPlugin(), tailwindcss(), vue(), Icons({ compiler: "vue3", scale: 1 })],
    base: "./",
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
