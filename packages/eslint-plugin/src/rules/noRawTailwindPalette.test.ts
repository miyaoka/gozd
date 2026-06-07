import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";

import rule from "./noRawTailwindPalette";

RuleTester.describe = describe;
RuleTester.it = test;

const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tsTester.run("no-raw-tailwind-palette (TS) — utility class 形", rule, {
  valid: [
    /* semantic token は通る */
    `const cls = "bg-background text-foreground-low";`,
    `const cls = "bg-element-active text-foreground";`,
    /* utility prefix 不在の plain string は palette 名でも通る */
    `const name = "zinc-800";`,
    `const greeting = "hello, slate-500";`,
    /* 動的補間は静的解析の限界として検知しない */
    "const cls = `bg-zinc-${level}`;",
    "const cls = `${prefix}-zinc-700`;",
    "const cls = `bg-${color}-700`;",
  ],
  invalid: [
    {
      code: `const cls = "bg-zinc-800";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      /* variant prefix + opacity 修飾子 */
      code: `const cls = "hover:bg-zinc-700/50";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-700/50" } }],
    },
    {
      /* important + 多段 variant */
      code: `const cls = "!dark:hover:text-blue-400";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "text-blue-400" } }],
    },
    {
      /* Tailwind v4 bracket variant (data-[…] / aria-[…] / peer-[…] / [&_li]) */
      code: `const cls = "data-[state=open]:bg-zinc-800";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      code: `const cls = "aria-[selected=true]:bg-zinc-700";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-700" } }],
    },
    {
      code: `const cls = "[&_li]:text-red-400";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "text-red-400" } }],
    },
    {
      /* 同一 string に複数違反 */
      code: `const cls = "bg-zinc-900 text-red-400 border-white";`,
      errors: [
        { messageId: "rawPaletteClass", data: { match: "bg-zinc-900" } },
        { messageId: "rawPaletteClass", data: { match: "text-red-400" } },
        { messageId: "rawPaletteClass", data: { match: "border-white" } },
      ],
    },
    {
      /* template literal の cooked text 部分 */
      code: "const cls = `bg-zinc-800 ${other}`;",
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      /* object key */
      code: `const cls = { "bg-zinc-800": isActive };`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      /* array element */
      code: `const cls = ["bg-zinc-800", "text-foreground"];`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
  ],
});

tsTester.run("no-raw-tailwind-palette (TS) — CSS var 形", rule, {
  valid: [
    /* semantic alias CSS var */
    `const css = "background-color: var(--color-panel);";`,
    /* utility 経由の semantic token (CSS var ではない) */
    `const cls = "bg-panel";`,
    /* 動的補間: palette / shade いずれが動的でも、`)` が静的に来ないため CSS_VAR_RE
     * (完成形 `)` 必須) にマッチしない */
    "const css = `var(--color-${palette}-700)`;",
    "const css = `var(--color-zinc-${shade})`;",
  ],
  invalid: [
    {
      /* CSS variable reference for raw palette */
      code: `const css = "color: var(--color-zinc-700);";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      /* arbitrary value 内 CSS var */
      code: `const cls = "[--md-code-bg:var(--color-zinc-700)]";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      /* 同一 string に複数違反 */
      code: `const css = "color: var(--color-blue-400); bg: var(--color-zinc-900);";`,
      errors: [
        { messageId: "rawPaletteCssVar", data: { match: "var(--color-blue-400)" } },
        { messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-900)" } },
      ],
    },
    {
      /* fallback 付き (`var(--x, fallback)`) — outer `var()` が CSS_VAR_RE 対象、
       * fallback 内の `var(--color-zinc-800)` は PRIMITIVE_VAR_RE / CSS_VAR_RE に
       * 個別 match する */
      code: `const css = "background: var(--md-code-bg, var(--color-zinc-800));";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-800)" } }],
    },
    {
      /* shade なし (`white` / `black`) */
      code: `const css = "background: var(--color-white);";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-white)" } }],
    },
  ],
});

tsTester.run("no-raw-tailwind-palette (TS) — primitive CSS var 直参照", rule, {
  valid: [
    /* semantic alias 経由は通る */
    `const css = "color: var(--color-foreground);";`,
    `const css = "background: var(--color-panel);";`,
    /* gozd の Tier 1 primitive 名と無関係な var (custom local CSS variable) は通る */
    `const css = "var(--md-code-bg)";`,
    `const css = "var(--sidebar-width)";`,
  ],
  invalid: [
    {
      code: `const css = "color: var(--gray-3);";`,
      errors: [{ messageId: "primitiveVar", data: { match: "var(--gray-3)" } }],
    },
    {
      /* alpha variant */
      code: `const css = "background: var(--gray-a6);";`,
      errors: [{ messageId: "primitiveVar", data: { match: "var(--gray-a6)" } }],
    },
    {
      code: `const css = "color: var(--blue-9);";`,
      errors: [{ messageId: "primitiveVar", data: { match: "var(--blue-9)" } }],
    },
    {
      /* 同一 string に複数違反 (gray + blue) */
      code: `const css = "color: var(--blue-11); border: var(--gray-7);";`,
      errors: [
        { messageId: "primitiveVar", data: { match: "var(--blue-11)" } },
        { messageId: "primitiveVar", data: { match: "var(--gray-7)" } },
      ],
    },
  ],
});

/* === Vue SFC === */
const vueTester = new RuleTester({
  languageOptions: {
    parser: vueParser,
    parserOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
});

vueTester.run("no-raw-tailwind-palette (Vue) — utility class 形", rule, {
  valid: [
    `<template><div class="flex items-center bg-background text-foreground"></div></template>`,
    `<template><div :class="active ? 'bg-element-active' : 'bg-panel'"></div></template>`,
    `<template><span class="text-foreground-low hover:text-foreground"></span></template>`,
  ],
  invalid: [
    {
      code: `<template><div class="bg-zinc-900"></div></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-900" } }],
    },
    {
      code: `<template><button class="hover:bg-zinc-800"></button></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      /* bracket variant in Vue template */
      code: `<template><div class="data-[state=open]:bg-zinc-800"></div></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      code: `<template><div :class="'bg-zinc-700/50'"></div></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-700/50" } }],
    },
    {
      code: `<template><div :class="{ 'bg-zinc-800': active }"></div></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
  ],
});

vueTester.run("no-raw-tailwind-palette (Vue) — CSS var 形 (<style> ブロック含む)", rule, {
  valid: [
    `<template><div /></template><style scoped>
.x { background: var(--color-panel); color: var(--color-foreground); }
</style>`,
    `<template><div class="[--md-code-bg:var(--color-element)]" /></template>`,
  ],
  invalid: [
    {
      /* <style> scoped 内 raw palette CSS var */
      code: `<template><div /></template><style scoped>
.x { color: var(--color-zinc-700); }
</style>`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      /* <style> 内 primitive 直参照 */
      code: `<template><div /></template><style scoped>
.x { color: var(--gray-3); }
</style>`,
      errors: [{ messageId: "primitiveVar", data: { match: "var(--gray-3)" } }],
    },
    {
      /* template arbitrary value 内 raw palette CSS var */
      code: `<template><div class="[--md-code-bg:var(--color-zinc-700)]" /></template>`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      /* <script> block 不在の Vue SFC でも Program 発火 (source-text scan が機能する) */
      code: `<template><div /></template><style>
.x { color: var(--color-zinc-700); }
</style>`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
  ],
});
