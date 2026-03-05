import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import type { ESLint } from "eslint";
import pluginBetterTailwindcss from "eslint-plugin-better-tailwindcss";
import pluginImportX from "eslint-plugin-import-x";
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
      // eslint-plugin-import-x の型が @typescript-eslint/utils の型を使用しており、
      // ESLint の defineConfig 型と互換性がない (typescript-eslint/typescript-eslint#11543)
      "import-x": pluginImportX as unknown as ESLint.Plugin,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      // unused-imports
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // import-x
      "import-x/no-duplicates": "warn",
      // 保存時の自動 lint で並び替えが発生すると編集中に邪魔なので off
      // lint:fix や pre-commit hook では eslint.config.fix.ts で有効化
      "import-x/order": [
        "off",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "object"],
          pathGroupsExcludedImportTypes: ["builtin", "external", "type"],
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
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
        "warn",
        {
          ignore: ["_.*"],
        },
      ],
      // 初回呼び出しで全クラスのシグネチャを計算するため重い
      // eslint.config.fix.ts で有効化
      "better-tailwindcss/enforce-canonical-classes": "off",
      // フォーマッタと競合するため off
      "better-tailwindcss/enforce-consistent-line-wrapping": "off",
      // フォーマッタと競合するため off
      "better-tailwindcss/no-unnecessary-whitespace": "off",
    },
  },

  // フォーマット系ルール無効化（最後に配置）
  skipFormatting,
);
