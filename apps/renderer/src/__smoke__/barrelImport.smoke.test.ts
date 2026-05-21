/**
 * `@miyaoka/eslint-plugin-barrel-import` が gozd の features / shared 構造に対して
 * 期待通り判定するかを確認する thin smoke test。
 *
 * eslint.config.ts 経由の本番 lint も検出経路として機能するが、
 * false-negative (検出漏れ) は CI が緑のまま起き得るため、固定 fixture で
 * 既知の違反パターンが必ず error 報告されることを保証する。
 *
 * upstream の dynamic import / TSImportType / barrel 判定変更で挙動が変わったら
 * このテストが落ちるよう、最小限の代表パターンだけを置く。
 */
import barrelImportPlugin from "@miyaoka/eslint-plugin-barrel-import";
import { describe, test } from "bun:test";
import { RuleTester } from "eslint";

RuleTester.describe = describe;
RuleTester.it = test;

const rule = barrelImportPlugin.rules["barrel-import"];

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

const SCOPES = {
  shared: { directories: ["shared"], dependsOn: [], isolateModules: true },
  features: { directories: ["features"], dependsOn: ["shared"] },
};

const BASE = "/project/apps/renderer/src";

tester.run("barrel-import (gozd scopes smoke)", rule, {
  valid: [
    // 同一 feature 内の通常ファイル参照
    {
      code: "import { foo } from './utils';",
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      options: [{ scopes: SCOPES }],
    },
    // feature 外 → feature バレル経由 (index.ts 暗黙解決)
    {
      code: "import { Foo } from '../features/sidebar';",
      filename: `${BASE}/App.vue`,
      options: [{ scopes: SCOPES }],
    },
    // 親 feature → ネストされた子 feature のバレル経由
    {
      code: "import { Worktree } from './features/worktree';",
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      options: [{ scopes: SCOPES }],
    },
    // feature → shared バレル経由
    {
      code: "import { rpc } from '../../shared/rpc';",
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      options: [{ scopes: SCOPES }],
    },
  ],
  invalid: [
    // feature 外 → 内部モジュール直接 import
    {
      code: "import { foo } from '../features/sidebar/utils';",
      filename: `${BASE}/App.vue`,
      options: [{ scopes: SCOPES }],
      errors: [{ messageId: "noDirectImport" }],
    },
    // 子 feature → 別の子 feature の内部モジュール直接 import
    {
      code: "import { foo } from '../worktree/utils';",
      filename: `${BASE}/features/sidebar/features/task/TaskRow.vue`,
      options: [{ scopes: SCOPES }],
      errors: [{ messageId: "noDirectImport" }],
    },
    // shared → features への依存は禁止 (バレル経由でも不可)
    {
      code: "import { something } from '../../features/sidebar';",
      filename: `${BASE}/shared/rpc/useRpc.ts`,
      options: [{ scopes: SCOPES }],
      errors: [{ messageId: "noDependency" }],
    },
    // isolateModules: shared 内のモジュール間 import は禁止
    {
      code: "import { foo } from '../notification';",
      filename: `${BASE}/shared/rpc/useRpc.ts`,
      options: [{ scopes: SCOPES }],
      errors: [{ messageId: "noCrossModuleDependency" }],
    },
  ],
});
