/**
 * `@iconify/tailwind4` 由来の icon utility class (`icon-[lucide--x]` 等) を禁止し、
 * unplugin-icons の per-icon component import (`import IconLucideX from "~icons/lucide/x"`)
 * を強制する (issue #715 の移行の再発防止)。
 *
 * Tailwind class 方式は typo が build を通過して silent broken になり、
 * Tailwind candidate parser と iconify name parser の二重 parse 衝突で
 * 警告ノイズも生むため、コンポーネント方式に一本化する。
 *
 * 検出: 文字列 (Literal / TemplateElement cooked / Vue VLiteral) 内の `icon-[`。
 * 動的補間 (`` `icon-[${name}]` ``) も cooked 先頭片に `icon-[` が現れるため拾える。
 * substring 判定なので variant prefix (`hover:icon-[...]`) も通さない。
 */
import type { Rule } from "eslint";
import type { AST as VueAST } from "vue-eslint-parser";

type Literal = Rule.Node & { type: "Literal" };
type TemplateElement = Rule.Node & {
  type: "TemplateElement";
  value: { cooked?: string | null; raw: string };
};

/** 表示用に `icon-[...]` 部分を抜き出す。閉じ括弧前で文字列が切れる動的補間片も拾う */
const ICONIFY_CLASS_RE = /icon-\[[^\]\s"']*\]?/;

function detectViolation(text: string): string | undefined {
  const m = text.match(ICONIFY_CLASS_RE);
  if (m === null) return undefined;
  return m[0];
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "iconify の Tailwind icon class (`icon-[lucide--x]` 等) を禁止し、unplugin-icons の per-icon component import を強制する",
    },
    messages: {
      iconifyClass:
        "Iconify Tailwind class `{{match}}` is forbidden. Import the icon component instead: `import IconLucideX from \"~icons/lucide/x\"` and render `<IconLucideX class=\"...\" />`.",
    },
    schema: [],
  },
  create(context) {
    function checkString(text: string, node: Rule.Node | VueAST.VLiteral): void {
      const violation = detectViolation(text);
      if (violation === undefined) return;
      context.report({
        node: node as Rule.Node,
        messageId: "iconifyClass",
        data: { match: violation },
      });
    }

    const scriptListener: Rule.RuleListener = {
      Literal(node: Literal) {
        if (typeof node.value !== "string") return;
        checkString(node.value, node);
      },
      TemplateElement(node: TemplateElement) {
        const cooked = node.value.cooked;
        if (typeof cooked !== "string") return;
        checkString(cooked, node);
      },
    };

    /* Vue SFC の template body AST は parserServices.defineTemplateBodyVisitor
     * 経由でのみ walk できる (noRawTailwindPalette と同じ構造) */
    type ParserServicesWithVue = {
      defineTemplateBodyVisitor?: (
        templateVisitor: Record<string, (node: Rule.Node | VueAST.VLiteral) => void>,
        scriptVisitor: Rule.RuleListener,
      ) => Rule.RuleListener;
    };
    const parserServices = context.sourceCode.parserServices as ParserServicesWithVue | undefined;
    if (parserServices?.defineTemplateBodyVisitor !== undefined) {
      return parserServices.defineTemplateBodyVisitor(
        {
          "VAttribute > VLiteral"(node) {
            checkString((node as VueAST.VLiteral).value, node);
          },
          Literal(node) {
            const lit = node as Literal;
            if (typeof lit.value !== "string") return;
            checkString(lit.value, lit);
          },
          TemplateElement(node) {
            const te = node as TemplateElement;
            const cooked = te.value.cooked;
            if (typeof cooked !== "string") return;
            checkString(cooked, te);
          },
        },
        scriptListener,
      );
    }
    return scriptListener;
  },
};

export default rule;
