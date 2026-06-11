import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";

import rule from "./noIconifyClass";

RuleTester.describe = describe;
RuleTester.it = test;

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tsTester.run("no-iconify-class (TS)", rule, {
  valid: [
    /* unplugin-icons の import 経路は通る */
    `import IconLucideX from "~icons/lucide/x";`,
    /* icon を含むだけの普通の文字列は通る */
    `const label = "icon name";`,
    `const cls = "size-4 text-foreground-low";`,
    /* arbitrary value 一般は対象外 */
    `const cls = "w-[10px]";`,
  ],
  invalid: [
    {
      code: `const cls = "icon-[lucide--x]";`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--x]" } }],
    },
    {
      /* 他 class との混在 */
      code: `const cls = "icon-[lucide--git-branch] size-4";`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--git-branch]" } }],
    },
    {
      /* variant prefix 付き */
      code: `const cls = "hover:icon-[lucide--x]";`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--x]" } }],
    },
    {
      /* 動的補間: cooked 先頭片の `icon-[` で検出 */
      code: "const cls = `icon-[${name}]`;",
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[" } }],
    },
    {
      /* object value (マッピングテーブル) */
      code: `const map = { added: "icon-[lucide--file-plus]" };`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--file-plus]" } }],
    },
  ],
});

const vueTester = new RuleTester({
  languageOptions: {
    parser: vueParser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: {
      parser: tsParser,
    },
  },
});

vueTester.run("no-iconify-class (Vue SFC)", rule, {
  valid: [
    {
      filename: "Component.vue",
      code: `<template><IconLucideX class="size-4" /></template>`,
    },
    {
      filename: "Component.vue",
      code: `
<script setup lang="ts">
import IconLucideX from "~icons/lucide/x";
</script>
<template><component :is="IconLucideX" /></template>
`,
    },
  ],
  invalid: [
    {
      /* plain class attribute */
      filename: "Component.vue",
      code: `<template><span class="icon-[lucide--x] size-4" /></template>`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--x]" } }],
    },
    {
      /* :class binding 内の string literal */
      filename: "Component.vue",
      code: `<template><span :class="active ? 'icon-[lucide--check]' : ''" /></template>`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--check]" } }],
    },
    {
      /* script 内のマッピングテーブル */
      filename: "Component.vue",
      code: `
<script setup lang="ts">
const ICON_CLASS = { workflow: "icon-[lucide--workflow]" };
</script>
<template><span :class="ICON_CLASS.workflow" /></template>
`,
      errors: [{ messageId: "iconifyClass", data: { match: "icon-[lucide--workflow]" } }],
    },
  ],
});
