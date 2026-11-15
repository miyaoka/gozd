import pluginGozd from "@gozd/eslint-plugin";
import pluginBarrelImport from "@miyaoka/eslint-plugin-barrel-import";
import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import pluginBetterTailwindcss from "eslint-plugin-better-tailwindcss";
import pluginUnusedImports from "eslint-plugin-unused-imports";
import pluginVue from "eslint-plugin-vue";

export default defineConfigWithVueTs(
  { ignores: ["dist/**", "node_modules/**"] },

  // Vue 推奨設定
  pluginVue.configs["flat/essential"],

  // TypeScript 設定（Vue 用、tseslint.configs.recommended の代わり）
  vueTsConfigs.recommended,

  // プラグイン + ルール
  {
    plugins: {
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      // unused-imports
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // vue/multi-word-component-names: 公式 essential 設定に含まれるが、Vue コア
      // (Transition / KeepAlive / Suspense / Teleport) や Headless UI 等のライブラリが
      // 単一語コンポーネント名を採用しており、実用上は強制する意味が薄れている。
      "vue/multi-word-component-names": "off",

      // vue: reactive() / watchEffect() を禁止
      // - reactive: ref() のみ使用する（issue #501）
      // - watchEffect: 依存が暗黙的で誤発火 / 漏れの原因になるため watch() を使う
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "vue",
              importNames: ["reactive"],
              message: "Use ref() instead. See issue #501.",
            },
            {
              name: "vue",
              importNames: ["watchEffect"],
              message: "Use watch() with explicit sources instead.",
            },
          ],
        },
      ],
    },
  },

  // eslint-disable コメントを禁止
  {
    linterOptions: {
      noInlineConfig: true,
    },
  },

  // tsconfigRootDir: モノレポで複数の tsconfig.json が存在する場合、
  // このパッケージの tsconfig.json を使用するよう明示的に指定
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Tailwind 設定
  {
    ...pluginBetterTailwindcss.configs.recommended,
    settings: {
      "better-tailwindcss": {
        entryPoint: "src/assets/main.css",
      },
    },
  },
  {
    rules: {
      // 各ルールは独立したワーカーで Tailwind Design System をロードするため、
      // 有効なルール数に比例して初期化コストが増加する（1ルールあたり約1秒）
      "better-tailwindcss/no-unknown-classes": [
        "error",
        {
          ignore: ["^_.*"],
        },
      ],
      "better-tailwindcss/enforce-canonical-classes": "error",
      // フォーマッタと競合するため off
      "better-tailwindcss/enforce-consistent-line-wrapping": "off",
      // フォーマッタと競合するため off
      "better-tailwindcss/no-unnecessary-whitespace": "off",
    },
  },

  // feature / shared のバレルファイル強制
  //
  // NG: feature 外 → 内部モジュール直接 import
  // NG: 親 feature 内 → 子 feature の内部モジュール直接 import（3階層目含む）
  // NG: 親 feature 内 → 子 feature のバレルでないファイル直接 import
  // NG: shared → feature
  // OK: feature 外 → バレル経由
  // OK: 親 feature 内 → 子 feature のバレル経由
  // OK: 親 feature 内 → 3 階層目の子 feature のバレル経由
  // OK: 同一 feature 内の通常ファイル参照
  {
    plugins: {
      "barrel-import": pluginBarrelImport,
      gozd: pluginGozd,
    },
    rules: {
      "barrel-import/barrel-import": [
        "error",
        {
          scopes: {
            shared: { directories: ["shared"], dependsOn: [], isolateModules: true },
            features: { directories: ["features"], dependsOn: ["shared"] },
          },
        },
      ],
      // 親から子の内部メソッドを命令的に呼ぶ設計を禁止
      // props または composable パターンを使う（issue #291）
      "gozd/no-define-expose": "error",

      // 生 Tailwind palette (bg-zinc-800 等) を禁止する。色は semantic token (`@theme` 定義) で書く
      // - SSOT: `src/assets/main.css` の @theme ブロック
      // - 規約: `.claude/skills/gozd-ui/SKILL.md`
      "gozd/no-raw-tailwind-palette": "error",

      // iconify の Tailwind icon class (icon-[lucide--x] 等) を禁止する。
      // icon は unplugin-icons の per-icon component import (`~icons/lucide/x`) で書く（issue #715）
      "gozd/no-iconify-class": "error",
    },
  },

  // フォーマット系ルール無効化（最後に配置）
  skipFormatting,
);
