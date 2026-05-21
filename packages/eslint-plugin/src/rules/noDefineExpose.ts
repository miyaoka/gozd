/**
 * Vue SFC の `defineExpose` の使用を禁止する。
 *
 * 親から子の内部メソッドを命令的に呼ぶ設計はコンポーネント間の依存を不透明にする。
 * 値は props で渡し、子が自分で処理する。共有ロジックは composable に出す。
 *
 * `defineExpose` は Vue の compiler macro であり、import されずに直接呼び出される。
 * AST 上は `CallExpression` で callee が Identifier "defineExpose" となるため、
 * その形だけを見て報告する。`foo.defineExpose()` のような member call は対象外。
 */
import type { Rule } from "eslint";

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Vue SFC の defineExpose の使用を禁止する",
    },
    messages: {
      noDefineExpose:
        "defineExpose は使用禁止です。親から子の内部メソッドを呼ぶ設計を避け、props または composable パターンを使ってください。",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "Identifier") return;
        if (callee.name !== "defineExpose") return;
        context.report({
          node: callee,
          messageId: "noDefineExpose",
        });
      },
    };
  },
};

export default rule;
