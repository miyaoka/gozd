import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";

import rule from "./noDefineExpose";

// bun:test を RuleTester に使わせる
RuleTester.describe = describe;
RuleTester.it = test;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

// Vue SFC で頻出する `defineExpose<T>(...)` の generic 型引数付き呼び出しは
// 標準 JS parser では parse できない。TypeScript parser を使う別 RuleTester で検証する。
const tsTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tester.run("no-define-expose", rule, {
  valid: [
    // 通常コード
    "const x = 1;",
    // 同名 method call（macro ではない）は対象外
    "foo.defineExpose({ bar: 1 });",
    // 別名で wrap した呼び出しは検出しない（識別子名一致のみ）
    "const expose = defineSomething; expose({ bar: 1 });",
  ],
  invalid: [
    {
      code: "defineExpose({ foo: () => {} });",
      errors: [{ messageId: "noDefineExpose" }],
    },
    {
      code: "defineExpose();",
      errors: [{ messageId: "noDefineExpose" }],
    },
    {
      // 引数の中身に関わらず callee の名前だけで判定
      code: "defineExpose({ ...obj });",
      errors: [{ messageId: "noDefineExpose" }],
    },
  ],
});

// TypeScript parser 経由で generic 型引数付きの呼び出しを検出することを確認する。
// Vue SFC では `defineExpose<{ focus(): void }>({ focus })` 形が頻出する。
tsTester.run("no-define-expose (TypeScript)", rule, {
  valid: ["const x: number = 1;", "type T = { foo: string }; const x: T = { foo: 'a' };"],
  invalid: [
    {
      code: "defineExpose<{ focus(): void }>({ focus: () => {} });",
      errors: [{ messageId: "noDefineExpose" }],
    },
    {
      code: "interface Exposed { reveal(): void; } defineExpose<Exposed>({ reveal: () => {} });",
      errors: [{ messageId: "noDefineExpose" }],
    },
  ],
});
