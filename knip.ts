import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // eslint: lefthook.yml で pnpm exec eslint として使用（renderer の devDep）
  // typecheck: pnpm -r で呼ぶワークスペースの scripts 名
  // buf: mise 経由で実行（packages/proto-ts の generate スクリプト）
  // swift: apps/native の scripts で Xcode 同梱の Swift toolchain を呼ぶ
  // open: macOS 標準コマンド（pnpm setup で .app を起動）
  ignoreBinaries: ["eslint", "typecheck", "buf", "swift", "open"],
  // SPM の .build/ 配下はサードパーティのビルド成果物。knip の対象外にする。
  // proto-ts の src/generated/ は buf 完全管理（clean: true で wipe される領域）。
  // ts-proto 由来の utility (DeepPartial / MessageFns / protobufPackage) は手書き
  // コードから参照しないため解析から外す。
  ignore: ["**/.build/**", "packages/proto-ts/src/generated/**"],
  workspaces: {
    ".": {},
    "apps/renderer": {
      ignoreDependencies: [
        // @iconify/tailwind4 が動的に require する（packageExtensions で補完済み）
        "@iconify-json/lucide",
      ],
    },
    "packages/eslint-plugin": {},
    "packages/proto-ts": {},
    "packages/shared": {},
    "packages/themes": {},
  },
};

export default config;
