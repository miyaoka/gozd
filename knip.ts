import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // macOS の open コマンド、pnpm -r で呼ぶワークスペースの scripts 名
  // eslint: lefthook.yml で pnpm exec eslint として使用（renderer の devDep）
  // open: macOS の /usr/bin/open コマンド
  // typecheck: pnpm -r で呼ぶワークスペースの scripts 名
  // buf: mise 経由で実行（packages/proto-ts の generate スクリプト）
  // swift: apps/native の scripts で Xcode 同梱の Swift toolchain を呼ぶ
  ignoreBinaries: ["eslint", "open", "typecheck", "buf", "swift"],
  // SPM の .build/ 配下はサードパーティのビルド成果物。knip の対象外にする。
  // proto-ts の src/generated/ は buf 完全管理（clean: true で wipe される領域）。
  // ts-proto 由来の utility (DeepPartial / MessageFns / protobufPackage) は手書き
  // コードから参照しないため解析から外す。
  ignore: ["**/.build/**", "packages/proto-ts/src/generated/**"],
  workspaces: {
    ".": {},
    "apps/cli": {
      // @miyaoka/fsss が commandsDir から動的にコマンドを発見するため明示的に指定
      entry: ["src/commands/*.ts"],
    },
    "apps/desktop": {
      // electrobun.config.ts: Electrobun のビルド設定（knip が自動認識しないフレームワーク）
      // placeholder.ts: electrobun.config.ts の views entrypoint（文字列参照のため knip が追跡できない）
      entry: ["src/index.ts", "electrobun.config.ts", "src/placeholder.ts"],
      ignoreDependencies: [
        // build.copy で node_modules からファイルをコピーする（import ではない）
        "@gozd/cli",
        "@gozd/renderer",
      ],
    },
    "apps/renderer": {
      ignoreDependencies: [
        // @iconify/tailwind4 が動的に require する（packageExtensions で補完済み）
        "@iconify-json/lucide",
      ],
    },
    "packages/eslint-plugin": {},
    "packages/proto-ts": {},
    "packages/rpc": {},
    "packages/shared": {},
    "packages/themes": {},
  },
};

export default config;
