import { docBlockPlugin } from "@miyaoka/vite-plugin-doc-block";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [docBlockPlugin(), tailwindcss(), vue()],
  base: "./",
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
