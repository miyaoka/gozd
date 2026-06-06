import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";

import rule from "./noRawTailwindPalette";

RuleTester.describe = describe;
RuleTester.it = test;

// === Plain TS / JS — string literal と template element を見る ===
const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tsTester.run("no-raw-tailwind-palette (TS)", rule, {
  valid: [
    // semantic token は通る
    `const cls = "bg-background text-foreground-muted";`,
    // palette 名単独 (utility prefix なし) は対象外 — data string
    `const name = "zinc-800";`,
    // 似た utility 名で palette が含まれないものは通る
    `const cls = "bg-accent-strong";`,
    // template literal 内 cooked が semantic
    "const cls = `bg-background ${state}`;",
    // utility prefix ではない palette 名 → 対象外
    `const greeting = "hello, slate-500";`,
  ],
  invalid: [
    {
      code: `const cls = "bg-zinc-800";`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-800" } }],
    },
    {
      // variant prefix + opacity 修飾子
      code: `const cls = "hover:bg-zinc-700/50";`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-700/50" } }],
    },
    {
      // important + variant
      code: `const cls = "!dark:hover:text-blue-400";`,
      errors: [{ messageId: "rawPalette", data: { match: "text-blue-400" } }],
    },
    {
      // 同一 string に複数違反
      code: `const cls = "bg-zinc-900 text-red-400 border-white";`,
      errors: [
        { messageId: "rawPalette", data: { match: "bg-zinc-900" } },
        { messageId: "rawPalette", data: { match: "text-red-400" } },
        { messageId: "rawPalette", data: { match: "border-white" } },
      ],
    },
    {
      // template literal の cooked text 部分
      code: "const cls = `bg-zinc-800 ${other}`;",
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-800" } }],
    },
    {
      // object key
      code: `const cls = { "bg-zinc-800": isActive };`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-800" } }],
    },
    {
      // array element
      code: `const cls = ["bg-zinc-800", "text-foreground"];`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-800" } }],
    },
  ],
});

// === Vue SFC — <template> の class 属性 (VLiteral) も見る ===
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

vueTester.run("no-raw-tailwind-palette (Vue)", rule, {
  valid: [
    // semantic token + 通常 layout 系は通る
    `<template><div class="flex items-center bg-background text-foreground"></div></template>`,
    // bound class でも semantic は通る
    `<template><div :class="active ? 'bg-accent-strong' : 'bg-surface-1'"></div></template>`,
    // accent-strong / foreground-muted などは palette 名を含まないので通る
    `<template><span class="text-foreground-muted hover:text-foreground"></span></template>`,
  ],
  invalid: [
    {
      // static class
      code: `<template><div class="bg-zinc-900"></div></template>`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-900" } }],
    },
    {
      // hover variant
      code: `<template><button class="hover:bg-zinc-800"></button></template>`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-800" } }],
    },
    {
      // :class string literal
      code: `<template><div :class="'bg-zinc-700/50'"></div></template>`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-700/50" } }],
    },
    {
      // :class object form (key)
      code: `<template><div :class="{ 'bg-zinc-800': active }"></div></template>`,
      errors: [{ messageId: "rawPalette", data: { match: "bg-zinc-800" } }],
    },
    {
      // 複数違反 (static class 内)
      code: `<template><div class="bg-zinc-900 text-blue-400"></div></template>`,
      errors: [
        { messageId: "rawPalette", data: { match: "bg-zinc-900" } },
        { messageId: "rawPalette", data: { match: "text-blue-400" } },
      ],
    },
  ],
});
