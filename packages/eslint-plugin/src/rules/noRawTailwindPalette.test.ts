import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";

import rule from "./noRawTailwindPalette";

RuleTester.describe = describe;
RuleTester.it = test;

// === Plain TS / JS ===
const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tsTester.run("no-raw-tailwind-palette (TS) — class utility 形", rule, {
  valid: [
    // semantic token
    `const cls = "bg-background text-foreground-muted";`,
    // utility prefix なしの palette 名 (data string)
    `const name = "zinc-800";`,
    // semantic token で palette と紛らわしい (foreground / accent-strong)
    `const cls = "bg-accent-strong text-foreground-strong";`,
    // template literal 内 cooked text が semantic
    "const cls = `bg-background ${state}`;",
    // 文中の palette 名 (utility prefix 不在)
    `const greeting = "hello, slate-500";`,
    // 動的補間で utility を構築するパターンは静的解析の限界として検知しない
    // (cooked text が "bg-zinc-" / "-700" に分割され、どちらも単独では utility 形にならない)
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
      // variant prefix + opacity 修飾子
      code: `const cls = "hover:bg-zinc-700/50";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-700/50" } }],
    },
    {
      // important + 多段 variant
      code: `const cls = "!dark:hover:text-blue-400";`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "text-blue-400" } }],
    },
    {
      // 同一 string に複数違反
      code: `const cls = "bg-zinc-900 text-red-400 border-white";`,
      errors: [
        { messageId: "rawPaletteClass", data: { match: "bg-zinc-900" } },
        { messageId: "rawPaletteClass", data: { match: "text-red-400" } },
        { messageId: "rawPaletteClass", data: { match: "border-white" } },
      ],
    },
    {
      // template literal の cooked text 部分
      code: "const cls = `bg-zinc-800 ${other}`;",
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      // object key
      code: `const cls = { "bg-zinc-800": isActive };`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      // array element
      code: `const cls = ["bg-zinc-800", "text-foreground"];`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
  ],
});

tsTester.run("no-raw-tailwind-palette (TS) — CSS var 形", rule, {
  valid: [
    // semantic token CSS variable
    `const css = "background-color: var(--color-surface-1);";`,
    // utility prefix 経由の semantic token (CSS var ではない)
    `const cls = "bg-surface-1";`,
    // 動的補間: palette / shade いずれが動的でも、`)` が静的に来ないため CSS_VAR_RE
    // (完成形 `)` 必須) にマッチしない。class utility 形の動的補間と同じ「静的解析の
    // 構造的限界」として揃える
    "const css = `var(--color-${palette}-700)`;",
    "const css = `var(--color-zinc-${shade})`;",
  ],
  invalid: [
    {
      // CSS variable reference for raw palette
      code: `const css = "color: var(--color-zinc-700);";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      // arbitrary value 内 CSS var (Tailwind arbitrary class)
      code: `const cls = "[--md-code-bg:var(--color-zinc-700)]";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      // 同一 string に複数違反
      code: `const css = "color: var(--color-blue-400); bg: var(--color-zinc-900);";`,
      errors: [
        { messageId: "rawPaletteCssVar", data: { match: "var(--color-blue-400)" } },
        { messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-900)" } },
      ],
    },
    {
      // fallback 付き (`var(--x, fallback)`)
      code: `const css = "background: var(--md-code-bg, var(--color-zinc-800));";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-800)" } }],
    },
    {
      // shade なし (`white` / `black`)
      code: `const css = "background: var(--color-white);";`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-white)" } }],
    },
  ],
});

// === Vue SFC ===
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

vueTester.run("no-raw-tailwind-palette (Vue) — class utility 形", rule, {
  valid: [
    `<template><div class="flex items-center bg-background text-foreground"></div></template>`,
    `<template><div :class="active ? 'bg-accent-strong' : 'bg-surface-1'"></div></template>`,
    `<template><span class="text-foreground-muted hover:text-foreground"></span></template>`,
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
      code: `<template><div :class="'bg-zinc-700/50'"></div></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-700/50" } }],
    },
    {
      code: `<template><div :class="{ 'bg-zinc-800': active }"></div></template>`,
      errors: [{ messageId: "rawPaletteClass", data: { match: "bg-zinc-800" } }],
    },
    {
      code: `<template><div class="bg-zinc-900 text-blue-400"></div></template>`,
      errors: [
        { messageId: "rawPaletteClass", data: { match: "bg-zinc-900" } },
        { messageId: "rawPaletteClass", data: { match: "text-blue-400" } },
      ],
    },
  ],
});

vueTester.run("no-raw-tailwind-palette (Vue) — CSS var 形 (<style> ブロック含む)", rule, {
  valid: [
    // <style> 内 semantic token
    `<template><div /></template><style scoped>
.x { background: var(--color-surface-1); color: var(--color-foreground); }
</style>`,
    // template の arbitrary value で semantic token を渡す
    `<template><div class="[--md-code-bg:var(--color-surface-2)]" /></template>`,
  ],
  invalid: [
    {
      // <style> scoped 内 raw palette CSS var
      code: `<template><div /></template><style scoped>
.x { color: var(--color-zinc-700); }
</style>`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      // template arbitrary value 内 raw palette CSS var
      code: `<template><div class="[--md-code-bg:var(--color-zinc-700)]" /></template>`,
      // 1 件: source-text scan が捕捉する (template 内文字列は arbitrary value で
      // utility 形検知の対象外、CSS var 検知の対象)
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
    {
      // <style> 内に複数の raw palette CSS var
      code: `<template><div /></template><style scoped>
.x { color: var(--color-zinc-300); background: var(--color-blue-400); }
</style>`,
      errors: [
        { messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-300)" } },
        { messageId: "rawPaletteCssVar", data: { match: "var(--color-blue-400)" } },
      ],
    },
    {
      // <script> block 不在の Vue SFC でも Program 発火 (= source-text scan が機能する)
      // ことの contract test。vue-eslint-parser は空 Module を Program として常に組み立てる
      code: `<template><div /></template><style>
.x { color: var(--color-zinc-700); }
</style>`,
      errors: [{ messageId: "rawPaletteCssVar", data: { match: "var(--color-zinc-700)" } }],
    },
  ],
});
