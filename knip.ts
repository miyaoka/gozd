import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // eslint: lefthook.yml で pnpm exec eslint として使用（renderer の devDep）
  // typecheck: pnpm -r で呼ぶワークスペースの scripts 名
  // open: macOS 標準コマンド（pnpm run open:app で .app を起動）
  ignoreBinaries: ["eslint", "typecheck", "open"],
  workspaces: {
    ".": {},
    "apps/electron": {
      // esbuild (build.ts) が bundle するエントリポイント。import graph の根が
      // package.json の main (dist/main.cjs) 側にあるため、knip からは unused に見える
      entry: [
        "src/main.ts",
        "src/preload.ts",
        "src/cli.ts",
        "src/renderer/main.ts",
        // utilityProcess で fork される別プロセスのエントリ（どの TS からも import されない）
        "src/fs/watcherProcess.ts",
        "src/pty/ptyHost.ts",
      ],
      // iconutil: macOS 標準コマンド（build:app script で iconset → icns 変換）
      ignoreBinaries: ["iconutil"],
      // electron-builder: buildApp.ts が spawnSync("pnpm", ["exec", "electron-builder", ...]) で
      // 呼ぶため、package.json scripts を読む knip からは unused に見える
      ignoreDependencies: ["electron-builder"],
    },
    "apps/renderer": {
      ignoreDependencies: [
        // unplugin-icons が `~icons/<collection>/*` virtual module の icon data source と
        // して動的に読み込む。コード上の import は virtual path で package 名に解決され
        // ないため、knip からは unused に見える
        "@iconify-json/lucide",
        "@iconify-json/mdi",
      ],
    },
    "packages/eslint-plugin": {},
    "packages/rpc": {},
    "packages/shared": {},
    "packages/shiki-lang-map": {},
    "packages/themes": {},
  },
};

export default config;
