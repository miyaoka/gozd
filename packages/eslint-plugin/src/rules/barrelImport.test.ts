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

/**
 * テスト用ディレクトリ構成:
 *
 * src/
 * ├── App.vue
 * ├── features/
 * │   ├── feat-A/
 * │   │   ├── index.ts                    ← バレル
 * │   │   ├── CompA.vue
 * │   │   └── storeA.ts
 * │   ├── feat-B/
 * │   │   ├── index.ts                    ← バレル
 * │   │   ├── index.vue
 * │   │   ├── CompB.vue
 * │   │   ├── utils.ts
 * │   │   └── features/
 * │   │       ├── feat-B-child-A/
 * │   │       │   ├── index.ts            ← バレル
 * │   │       │   ├── CompBA.vue
 * │   │       │   └── features/
 * │   │       │       └── feat-B-grandchild/
 * │   │       │           ├── index.ts    ← バレル
 * │   │       │           └── internal.ts
 * │   │       └── feat-B-child-B/
 * │   │           ├── index.ts            ← バレル
 * │   │           └── CompBB.vue
 * │   └── feat-C/
 * │       └── storeC.ts
 * └── shared/
 *     ├── shared-A/
 *     │   ├── index.ts                    ← バレル
 *     │   └── implA.ts
 *     └── shared-B/
 *         ├── useB.ts
 *         └── otherB.ts
 */

tester.run("barrel-import", rule, {
  valid: [
    // ─── feature 間: バレル経由 ──────────────────────
    {
      // feat-A/CompA.vue → feat-B/（バレル）
      name: "OK: feature 間のバレル経由",
      code: 'import { CompB } from "../feat-B";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
    },
    {
      // feat-A/CompA.vue → feat-B/index.ts（バレル明示指定）
      name: "OK: feature 間のバレル経由（index.ts 明示）",
      code: 'import { CompB } from "../feat-B/index.ts";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
    },
    {
      // feat-A/CompA.vue → feat-B/（バレル re-export）
      name: "OK: バレル経由の re-export",
      code: 'export { CompB } from "../feat-B";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
    },

    // ─── 親 → 子 feature: バレル経由 ────────────────
    {
      // feat-B/CompB.vue → feat-B/features/feat-B-child-A/（バレル）
      name: "OK: 親 feature → 子 feature のバレル経由",
      code: 'import { CompBA } from "./features/feat-B-child-A";',
      filename: `${BASE}/features/feat-B/CompB.vue`,
    },
    {
      // feat-B/CompB.vue → feat-B/features/feat-B-child-A/features/feat-B-grandchild/（バレル）
      name: "OK: 親 feature → 孫 feature のバレル経由",
      code: 'import { deep } from "./features/feat-B-child-A/features/feat-B-grandchild";',
      filename: `${BASE}/features/feat-B/CompB.vue`,
    },

    // ─── 同一スコープ内 ─────────────────────────────
    {
      // feat-B/CompB.vue → feat-B/utils.ts
      name: "OK: 同一 feature 内の参照",
      code: 'import { helper } from "./utils";',
      filename: `${BASE}/features/feat-B/CompB.vue`,
    },
    {
      // feat-B-child-B/CompBB.vue → feat-B-child-B/OtherBB.vue（同一子 feature 内）
      name: "OK: 子 feature 内のファイル同士",
      code: 'import OtherBB from "./OtherBB.vue";',
      filename: `${BASE}/features/feat-B/features/feat-B-child-B/CompBB.vue`,
    },

    // ─── 子 → 親スコープ ────────────────────────────
    {
      // feat-B-child-B/CompBB.vue → feat-B/utils.ts
      name: "OK: 子 feature から親 feature の内部ファイル参照",
      code: 'import { helper } from "../../utils";',
      filename: `${BASE}/features/feat-B/features/feat-B-child-B/CompBB.vue`,
    },

    // ─── 子 feature 間: バレル経由 ──────────────────
    {
      // feat-B-child-B/CompBB.vue → feat-B/features/feat-B-child-A/（バレル）
      name: "OK: 子 feature 間のバレル経由",
      code: 'import { CompBA } from "../feat-B-child-A";',
      filename: `${BASE}/features/feat-B/features/feat-B-child-B/CompBB.vue`,
    },

    // ─── 子 → 外部 feature: バレル経由 ─────────────
    {
      // feat-B-child-A/CompBA.vue → feat-A/（バレル）
      name: "OK: 子 feature から外部 feature のバレル経由",
      code: 'import { CompA } from "../../../feat-A";',
      filename: `${BASE}/features/feat-B/features/feat-B-child-A/CompBA.vue`,
    },

    // ─── shared ─────────────────────────────────────
    {
      // shared-B/useB.ts → shared-B/otherB.ts
      name: "OK: shared 内のファイル同士",
      code: 'import { otherB } from "./otherB";',
      filename: `${BASE}/shared/shared-B/useB.ts`,
    },
    {
      // feat-A/CompA.vue → shared-A/（バレル）
      name: "OK: feature → shared のバレル経由",
      code: 'import { implA } from "../../shared/shared-A";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
    },

    // ─── App.vue（スコープ外） ──────────────────────
    {
      // App.vue → shared-A/（バレル）
      name: "OK: App.vue → shared のバレル経由",
      code: 'import { implA } from "./shared/shared-A";',
      filename: `${BASE}/App.vue`,
    },
    {
      // App.vue → feat-A/（バレル）
      name: "OK: App.vue → feature のバレル経由",
      code: 'import { CompA } from "./features/feat-A";',
      filename: `${BASE}/App.vue`,
    },

    // ─── index.tsx バレル ─────────────────────────────
    {
      // feat-A/CompA.vue → feat-B/index.tsx（デフォルトで tsx も許可）
      name: "OK: feature 間のバレル経由（index.tsx 明示）",
      code: 'import { CompB } from "../feat-B/index.tsx";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
    },

    // ─── barrelFiles オプション ─────────────────────
    {
      // barrelFiles に index.js を追加 → index.js 明示が許可される
      name: "OK: barrelFiles オプションで index.js を許可",
      code: 'import { CompB } from "../feat-B/index.js";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      options: [{ barrelFiles: ["index.ts", "index.tsx", "index.js"] }],
    },
    {
      // barrelFiles を変更しても拡張子なし import は常に許可される
      name: "OK: barrelFiles に関係なく拡張子なしディレクトリ import は許可",
      code: 'import { CompB } from "../feat-B";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      options: [{ barrelFiles: ["index.js"] }],
    },

    // ─── 外部パッケージ ─────────────────────────────
    {
      name: "OK: 外部パッケージはスキップ",
      code: 'import { ref } from "vue";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
    },
  ],
  invalid: [
    // ─── feature 間: 内部ファイル直接 ───────────────
    {
      // feat-A/CompA.vue → feat-B/storeB.ts
      name: "NG: feature 間の内部モジュール直接 import",
      code: 'import { storeB } from "../feat-B/storeB";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── 外部 → 子 feature 直接参照 ────────────────
    {
      // feat-A/CompA.vue → feat-B/features/feat-B-child-A/（バレル経由でも禁止）
      name: "NG: 外部 feature → 別 feature の子 feature を直接参照",
      code: 'import { CompBA } from "../feat-B/features/feat-B-child-A";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      // feat-A/CompA.vue → feat-B/features/feat-B-child-A/index.ts（index.ts 明示でも禁止）
      name: "NG: 外部 feature → 子 feature の index.ts を明示指定",
      code: 'import { CompBA } from "../feat-B/features/feat-B-child-A/index.ts";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      // App.vue → feat-B/features/feat-B-child-A/（バレル経由でも禁止）
      name: "NG: App.vue → 子 feature を直接参照",
      code: 'import { CompBA } from "./features/feat-B/features/feat-B-child-A";',
      filename: `${BASE}/App.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      // App.vue → feat-B/features/feat-B-child-A/index.ts（index.ts 明示でも禁止）
      name: "NG: App.vue → 子 feature の index.ts を明示指定",
      code: 'import { CompBA } from "./features/feat-B/features/feat-B-child-A/index.ts";',
      filename: `${BASE}/App.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── 親 → 子 feature: 内部ファイル直接 ─────────
    {
      // feat-B/CompB.vue → feat-B-child-A/CompBA.vue
      name: "NG: 親 feature → 子 feature の内部モジュール直接 import",
      code: 'import CompBA from "./features/feat-B-child-A/CompBA.vue";',
      filename: `${BASE}/features/feat-B/CompB.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      // feat-B/CompB.vue → feat-B-grandchild/internal.ts
      name: "NG: 親 feature → 孫 feature の内部モジュール直接 import",
      code: 'import { internalOnly } from "./features/feat-B-child-A/features/feat-B-grandchild/internal";',
      filename: `${BASE}/features/feat-B/CompB.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── 子 feature 間: 内部ファイル直接 ───────────
    {
      // feat-B-child-B/CompBB.vue → feat-B-child-A/CompBA.vue
      name: "NG: 子 feature 間の内部直接 import",
      code: 'import CompBA from "../feat-B-child-A/CompBA.vue";',
      filename: `${BASE}/features/feat-B/features/feat-B-child-B/CompBB.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── shared → features ──────────────────────────
    {
      // shared-B/otherB.ts → feat-A/（バレル経由でも禁止）
      name: "NG: shared → feature（バレル経由でも禁止）",
      code: 'import { CompA } from "../../features/feat-A";',
      filename: `${BASE}/shared/shared-B/otherB.ts`,
      errors: [{ messageId: "noSharedToFeature" }],
    },

    // ─── shared: 内部ファイル直接 ──────────────────
    {
      // feat-A/CompA.vue → shared-A/implA.ts
      name: "NG: shared の内部モジュール直接 import",
      code: 'import { implA } from "../../shared/shared-A/implA";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── App.vue → 内部ファイル直接 ────────────────
    {
      // App.vue → feat-C/storeC.ts
      name: "NG: App.vue → feature の内部モジュール直接 import",
      code: 'import { storeC } from "./features/feat-C/storeC";',
      filename: `${BASE}/App.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── re-export で内部直接参照 ───────────────────
    {
      // feat-A/CompA.vue → feat-B/storeB.ts
      name: "NG: export {} で内部モジュール直接 re-export",
      code: 'export { storeB } from "../feat-B/storeB";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      // feat-A/CompA.vue → feat-B/storeB.ts
      name: "NG: export * で内部モジュール直接 re-export",
      code: 'export * from "../feat-B/storeB";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── barrelFiles に含まれないファイルはバレルではない ─
    {
      // feat-A/CompA.vue → feat-B/index.vue（デフォルトで非許可）
      name: "NG: index.vue はバレルファイルではない",
      code: 'import FeatBIndex from "../feat-B/index.vue";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },
    {
      // feat-A/CompA.vue → feat-B/index.js（デフォルトで非許可）
      name: "NG: index.js はデフォルトでバレルファイルではない",
      code: 'import { CompB } from "../feat-B/index.js";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      errors: [{ messageId: "noDirectImport" }],
    },

    // ─── barrelFiles オプション下での子 feature 制限 ─
    {
      // barrelFiles で index.js を許可しても、外部 → 子 feature の index.js は禁止
      name: "NG: barrelFiles で許可しても外部 → 子 feature の index.js は禁止",
      code: 'import { CompBA } from "../feat-B/features/feat-B-child-A/index.js";',
      filename: `${BASE}/features/feat-A/CompA.vue`,
      options: [{ barrelFiles: ["index.ts", "index.tsx", "index.js"] }],
      errors: [{ messageId: "noDirectImport" }],
    },
  ],
});
