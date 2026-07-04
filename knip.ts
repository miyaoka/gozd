import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // eslint: lefthook.yml で pnpm exec eslint として使用（renderer の devDep）
  // typecheck: pnpm -r で呼ぶワークスペースの scripts 名
  // open: macOS 標準コマンド（pnpm run bootstrap で .app を起動）
  ignoreBinaries: ["eslint", "typecheck", "open"],
  workspaces: {
    ".": {},
    "apps/electron": {
      // esbuild (build.ts) が bundle するエントリポイント。import graph の根が
      // package.json の main (dist/main.cjs) 側にあるため、knip からは unused に見える
      entry: ["src/main.ts", "src/preload.ts", "src/cli.ts", "src/renderer/main.ts"],
      // iconutil: macOS 標準コマンド（build:app script で iconset → icns 変換）
      ignoreBinaries: ["iconutil"],
    },
    "apps/renderer": {
      ignoreDependencies: [
        // unplugin-icons が `~icons/lucide/*` virtual module の icon data source として
        // 動的に読み込む。コード上の import は virtual path で package 名に解決されない
        // ため、knip からは unused に見える
        "@iconify-json/lucide",
      ],
      // unplugin-icons の `~icons/lucide/*` は Vite が build 時に生成する virtual module で
      // ディスク上に実体がない。静的解析する knip は恒久的に解決できず Unresolved imports に
      // 出すため、specifier パターンで除外する（上の ignoreDependencies とは別系統の検査）。
      ignoreUnresolved: [/^~icons\//],
    },
    "packages/eslint-plugin": {},
    "packages/rpc": {},
    "packages/shared": {},
    "packages/shiki-lang-map": {},
    "packages/themes": {},
  },
};

export default config;
