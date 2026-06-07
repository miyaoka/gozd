import { docBlockPlugin } from "@miyaoka/vite-plugin-doc-block";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [docBlockPlugin(), tailwindcss(), vue()],
  base: "./",
  server: {
    // Vite default の 5173 ではなく gozd 固有ポートを使う。strictPort により
    // 二重 `pnpm dev` / 別 Vite アプリと衝突したら即時 fail させる。fallback すると
    // Swift `.app` の GOZD_DEV_VITE_URL は固定なので先発の Vite に繋がって
    // 「別 worktree のはずなのに先発の内容が表示される」事故になる
    port: 16873,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    // material-icon-theme の SVG（1200+個）がインライン化されて JS が肥大化するのを防ぐ
    assetsInlineLimit: 0,
    // node:fs 等の Node.js モジュールを空モジュールに置き換え、別チャンクとして出力させない
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
