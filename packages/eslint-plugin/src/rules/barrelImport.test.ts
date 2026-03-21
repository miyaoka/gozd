import { describe, test } from "bun:test";
import { RuleTester } from "eslint";

import rule from "./barrelImport";

// bun:test を RuleTester に使わせる
RuleTester.describe = describe;
RuleTester.it = test;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

const BASE = "/project/apps/renderer/src";

tester.run("barrel-import", rule, {
  valid: [
    {
      name: "OK: feature 外 → バレル経由",
      code: 'import { useTerminalStore } from "../terminal";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
    },
    {
      name: "OK: 親 feature 内 → 子 feature のバレル経由",
      code: 'import { BranchList } from "./features/worktree";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
    },
    {
      name: "OK: 親 feature 内 → 3 階層目の子 feature のバレル経由",
      code: 'import { testNested } from "./features/worktree/features/testNested";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
    },
    {
      name: "OK: 同一 feature 内の通常ファイル参照",
      code: 'import { dirName } from "./utils";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
    },
    {
      name: "OK: 子 feature 内のファイル同士",
      code: 'import TodoIconPicker from "./TodoIconPicker.vue";',
      filename: `${BASE}/features/sidebar/features/todo/TodoEditor.vue`,
    },
    {
      name: "OK: 子 feature から親の通常ファイル参照",
      code: 'import { todoTitle } from "../../utils";',
      filename: `${BASE}/features/sidebar/features/todo/TodoList.vue`,
    },
    {
      name: "OK: 子 feature から外部 feature のバレル経由",
      code: 'import { ClaudeStatus } from "../../../terminal";',
      filename: `${BASE}/features/sidebar/features/worktree/WorktreeItem.vue`,
    },
    {
      name: "OK: 外部パッケージはスキップ",
      code: 'import { ref } from "vue";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
    },
    {
      name: "OK: shared 内のファイル同士",
      code: 'import { useCommandRegistry } from "./useCommandRegistry";',
      filename: `${BASE}/shared/command/useKeyBindings.ts`,
    },
    {
      name: "OK: feature → shared のバレル経由",
      code: 'import { useRpc } from "../../shared/rpc";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
    },
    {
      name: "OK: App.vue → shared のバレル経由",
      code: 'import { useRpc } from "./shared/rpc";',
      filename: `${BASE}/App.vue`,
    },
    {
      name: "OK: App.vue → feature のバレル経由",
      code: 'import { MainLayout } from "./features/layout";',
      filename: `${BASE}/App.vue`,
    },
    {
      name: "OK: バレル経由の re-export",
      code: 'export { useTerminalStore } from "../terminal";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
    },
  ],
  invalid: [
    {
      name: "NG: feature 外 → 内部モジュール直接 import",
      code: 'import { useTerminalStore } from "../terminal/useTerminalStore";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: 親 feature 内 → 子 feature の内部モジュール直接 import",
      code: 'import BranchList from "./features/worktree/BranchList.vue";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: 親 feature 内 → 3 階層目の子 feature の内部モジュール直接 import",
      code: 'import { internalOnly } from "./features/worktree/features/testNested/internal";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: 子 feature 間の内部直接 import",
      code: 'import WorktreeItem from "../worktree/WorktreeItem.vue";',
      filename: `${BASE}/features/sidebar/features/todo/boundaryTest.ts`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: shared → feature（バレル経由でも禁止）",
      code: 'import { useTerminalStore } from "../../features/terminal";',
      filename: `${BASE}/shared/command/boundaryTest.ts`,
      errors: [{ messageId: "noSharedToFeature" }],
    },
    {
      name: "NG: shared の内部モジュール直接 import",
      code: 'import { useRpc } from "../../shared/rpc/useRpc";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: App.vue → feature の内部モジュール直接 import",
      code: 'import { useWorkspaceStore } from "./features/filer/useWorkspaceStore";',
      filename: `${BASE}/App.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: export {} で内部モジュール直接 re-export",
      code: 'export { useTerminalStore } from "../terminal/useTerminalStore";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: export * で内部モジュール直接 re-export",
      code: 'export * from "../terminal/useTerminalStore";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      name: "NG: index.vue はバレルファイルではない",
      code: 'import TerminalIndex from "../terminal/index.vue";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
  ],
});
