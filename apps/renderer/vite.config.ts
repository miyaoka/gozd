import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  base: "./",
  build: {
    outDir: "dist",
    // node:fs 等の Node.js モジュールを空モジュールに置き換え、別チャンクとして出力させない
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
  // electrobun/view はソース TS を直接 export しており、内部で .js 拡張子の import を使っている
  // node_modules 内の TS ファイルを Vite が正しく処理するために optimizeDeps に含める
  optimizeDeps: {
    include: ["electrobun/view"],
  },
});
