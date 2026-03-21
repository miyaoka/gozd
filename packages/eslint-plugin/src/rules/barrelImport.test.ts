import { describe, test } from "bun:test";
import { RuleTester } from "eslint";

import rule from "./barrelImport";

// RuleTester は内部で node:assert を使うので、bun:test の describe/test でラップする
const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

// テスト用のベースパス
const BASE = "/project/apps/renderer/src";

describe("barrel-import", () => {
  test("valid ケース", () => {
    tester.run("barrel-import", rule, {
      valid: [
        // OK: feature 外 → バレル経由（拡張子なし = ディレクトリ名 = index.ts 暗黙解決）
        {
          code: 'import { useTerminalStore } from "../terminal";',
          filename: `${BASE}/features/layout/MainLayout.vue`,
        },
        // OK: 親 feature 内 → 子 feature のバレル経由
        {
          code: 'import { BranchList } from "./features/worktree";',
          filename: `${BASE}/features/sidebar/SidebarPane.vue`,
        },
        // OK: 親 feature 内 → 3 階層目の子 feature のバレル経由
        {
          code: 'import { testNested } from "./features/worktree/features/testNested";',
          filename: `${BASE}/features/sidebar/SidebarPane.vue`,
        },
        // OK: 同一 feature 内の通常ファイル参照
        {
          code: 'import { dirName } from "./utils";',
          filename: `${BASE}/features/sidebar/SidebarPane.vue`,
        },
        // OK: 子 feature 内のファイル同士
        {
          code: 'import TodoIconPicker from "./TodoIconPicker.vue";',
          filename: `${BASE}/features/sidebar/features/todo/TodoEditor.vue`,
        },
        // OK: 子 feature から親の通常ファイル参照
        {
          code: 'import { todoTitle } from "../../utils";',
          filename: `${BASE}/features/sidebar/features/todo/TodoList.vue`,
        },
        // OK: 子 feature から外部 feature のバレル経由
        {
          code: 'import { ClaudeStatus } from "../../../terminal";',
          filename: `${BASE}/features/sidebar/features/worktree/WorktreeItem.vue`,
        },
        // OK: 外部パッケージはスキップ
        {
          code: 'import { ref } from "vue";',
          filename: `${BASE}/features/sidebar/SidebarPane.vue`,
        },
        // OK: shared 内のファイル同士
        {
          code: 'import { useCommandRegistry } from "./useCommandRegistry";',
          filename: `${BASE}/shared/command/useKeyBindings.ts`,
        },
        // OK: feature → shared のバレル経由
        {
          code: 'import { useRpc } from "../../shared/rpc";',
          filename: `${BASE}/features/layout/MainLayout.vue`,
        },
        // OK: App.vue → shared のバレル経由
        {
          code: 'import { useRpc } from "./shared/rpc";',
          filename: `${BASE}/App.vue`,
        },
        // OK: App.vue → feature のバレル経由
        {
          code: 'import { MainLayout } from "./features/layout";',
          filename: `${BASE}/App.vue`,
        },
      ],
      invalid: [],
    });
  });

  const invalidCases = [
    {
      name: "NG: feature 外 → 内部モジュール直接 import",
      code: 'import { useTerminalStore } from "../terminal/useTerminalStore";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      messageId: "noDirectImport",
    },
    {
      name: "NG: 親 feature 内 → 子 feature の内部モジュール直接 import",
      code: 'import BranchList from "./features/worktree/BranchList.vue";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      messageId: "noDirectImport",
    },
    {
      name: "NG: 親 feature 内 → 3 階層目の子 feature の内部モジュール直接 import",
      code: 'import { internalOnly } from "./features/worktree/features/testNested/internal";',
      filename: `${BASE}/features/sidebar/SidebarPane.vue`,
      messageId: "noDirectImport",
    },
    {
      name: "NG: 子 feature 間の内部直接 import（todo → worktree の内部ファイル）",
      code: 'import WorktreeItem from "../worktree/WorktreeItem.vue";',
      filename: `${BASE}/features/sidebar/features/todo/boundaryTest.ts`,
      messageId: "noDirectImport",
    },
    {
      name: "NG: shared → feature（バレル経由でも禁止）",
      code: 'import { useTerminalStore } from "../../features/terminal";',
      filename: `${BASE}/shared/command/boundaryTest.ts`,
      messageId: "noSharedToFeature",
    },
    {
      name: "NG: shared の内部モジュール直接 import",
      code: 'import { useRpc } from "../../shared/rpc/useRpc";',
      filename: `${BASE}/features/layout/MainLayout.vue`,
      messageId: "noDirectImport",
    },
    {
      name: "NG: App.vue → feature の内部モジュール直接 import",
      code: 'import { useWorkspaceStore } from "./features/filer/useWorkspaceStore";',
      filename: `${BASE}/App.vue`,
      messageId: "noDirectImport",
    },
  ];

  for (const { name, code, filename, messageId } of invalidCases) {
    test(name, () => {
      tester.run("barrel-import", rule, {
        valid: [],
        invalid: [{ code, filename, errors: [{ messageId }] }],
      });
    });
  }
});
