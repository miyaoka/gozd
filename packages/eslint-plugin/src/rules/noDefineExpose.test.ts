import { describe, test } from "bun:test";
import { RuleTester } from "eslint";

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
