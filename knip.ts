import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // eslint: lefthook.yml で pnpm exec eslint として使用（renderer の devDep）
  // typecheck: pnpm -r で呼ぶワークスペースの scripts 名
  // buf: mise 経由で実行（packages/proto の prepare / build スクリプト）
  // swift: apps/native の scripts で Xcode 同梱の Swift toolchain を呼ぶ
  // open: macOS 標準コマンド（pnpm run bootstrap で .app を起動）
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
        // unplugin-icons が `~icons/lucide/*` virtual module の icon data source として
        // 動的に読み込む。コード上の import は virtual path で package 名に解決されない
        // ため、knip からは unused に見える
        "@iconify-json/lucide",
      ],
    },
    "packages/eslint-plugin": {},
    "packages/proto": {
      // buf は mise 経由で実行（packages/proto/prepare で `buf generate`）
      ignoreBinaries: ["buf"],
    },
    "packages/proto-ts": {
      // @bufbuild/protobuf は src/generated/ の生成物だけが参照する runtime dep。
      // 生成物は knip 解析対象外 (ignore 指定) なので、手書きコードから見ると
      // unused に誤検出される。明示的に保護する。
      ignoreDependencies: ["@bufbuild/protobuf"],
    },
    "packages/shared": {},
    "packages/shiki-lang-map": {},
    "packages/themes": {},
  },
};

export default config;
