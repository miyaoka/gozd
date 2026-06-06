/**
 * 生 Tailwind palette utility (例: `bg-zinc-800` / `text-blue-400` / `hover:bg-white/5`) を禁止する。
 *
 * gozd は色 token を `apps/renderer/src/assets/main.css` の `@theme` に集約する SSOT 規約で、
 * 全 UI は semantic token (`bg-background` / `text-foreground-muted` / `bg-accent` 等) で書く。
 * 生 palette は AI / 人間どちらが書いてもこの規約を破壊するため lint で機械的に止める。
 *
 * 検知対象:
 *   - Vue template の `class="..."` (static literal)
 *   - JS / TS / Vue script の string literal / template literal
 *     - これにより `:class="'bg-zinc-800'"` / `:class="['bg-zinc-800']"` / `:class="{ 'bg-zinc-800': x }"` /
 *       `:class="cn('bg-zinc-800', ...)"` / template literal `\`bg-${shade}\`` (text 部分) を補足する
 *
 * 検出パターンは `<prefix>-<palette>(-<shade>)?(/<opacity>)?` の utility 形のみ。
 * `zinc-800` 単独 (data string 等) は対象外。variant prefix (`hover:` / `dark:` 等) や important (`!`)
 * は左境界 lookbehind が `[A-Za-z0-9_-]` を除外するので自然に通る。
 *
 * 採用判断:
 *   - off-the-shelf の Tailwind ESLint plugin (better-tailwindcss / @poupe / francoismassart)
 *     は class 属性 ban を持たない、または CSS ファイル専用 (poupe は `.css` / `<style>` だけ)
 *   - oxlint-tailwindcss は ESLint 互換でなく Vue lint に乗らない
 *   - SSOT が単一 `@theme` ブロックで明確、かつ pattern が固定なので自前で十分
 */
import type { AST as VueAST } from "vue-eslint-parser";
import type { Rule } from "eslint";

const UTILITY_PREFIX = [
  "bg",
  "text",
  "border",
  "ring",
  "divide",
  "from",
  "via",
  "to",
  "decoration",
  "outline",
  "caret",
  "fill",
  "stroke",
  "placeholder",
  "accent",
  "shadow",
];

const PALETTE = [
  // grayscale
  "zinc",
  "neutral",
  "stone",
  "gray",
  "slate",
  // chromatic
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  // achromatic
  "white",
  "black",
];

// `<prefix>-<palette>(-<shade>)?(/<opacity>)?` を utility 識別子の境界 (前後が
// `[A-Za-z0-9_-]` でない) で抽出する。variant prefix と important は左の `:` / `!` で
// 自然に区切られるので lookbehind が排除しない。
const PALETTE_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${UTILITY_PREFIX.join("|")})-(?:${PALETTE.join("|")})(?:-\\d+)?(?:/\\d+)?(?![A-Za-z0-9_-])`,
  "g",
);

// Rule.Node の union (script 側) と VueAST.VLiteral (template 側) のどちらも
// `context.report` に node として渡せるが、両 union を表現する DOM 横断型は無いので
// any-like の最小受け口で受け、呼び出し側で渡し分ける。
type ReportNode = Rule.Node | VueAST.VLiteral;
interface CheckTarget {
  text: string;
  node: ReportNode;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "生 Tailwind palette (bg-zinc-800 等) を禁止する。semantic token (`@theme` 由来) を使う",
    },
    messages: {
      rawPalette:
        "Raw Tailwind palette `{{match}}` is forbidden. Use a semantic token defined in `apps/renderer/src/assets/main.css` (`bg-background` / `text-foreground-muted` / `bg-accent` 等). See `.claude/skills/gozd-ui/SKILL.md`.",
    },
    schema: [],
  },
  create(context) {
    function report(target: CheckTarget) {
      for (const match of target.text.matchAll(PALETTE_RE)) {
        context.report({
          // VueAST.VLiteral も loc/range を持つので runtime は OK。型上の union を畳む。
          node: target.node as Rule.Node,
          messageId: "rawPalette",
          data: { match: match[0] },
        });
      }
    }

    const scriptVisitor: Rule.RuleListener = {
      Literal(node) {
        if (typeof node.value !== "string") return;
        report({ text: node.value, node });
      },
      TemplateElement(node) {
        report({ text: node.value.cooked ?? node.value.raw, node });
      },
    };

    // vue-eslint-parser で parse された Vue SFC は `parserServices.defineTemplateBodyVisitor` を
    // 経由しないと `<template>` の AST に到達できない。非 Vue ファイル (素の TS/JS) は
    // parserServices に居ないので script visitor だけ返す。
    // 引数 / 返却の listener 型は eslint の `Rule.RuleListener` を gracefully に受ける形に緩めて、
    // codepath callback の (segment, node) のような多引数 signature と spread 互換にする。
    type LooseVisitor = Record<string, (...args: unknown[]) => void>;
    const services = context.sourceCode.parserServices as
      | {
          defineTemplateBodyVisitor?: (
            templateVisitor: LooseVisitor,
            scriptVisitor?: LooseVisitor,
          ) => Rule.RuleListener;
        }
      | undefined;

    if (services?.defineTemplateBodyVisitor !== undefined) {
      // template visitor は <template> 配下の AST (VLiteral など Vue 独自ノード +
      // VExpressionContainer 内の JS 式) を見る。`:class="'bg-zinc-800'"` のような
      // directive 内 string literal もここに居るため Literal / TemplateElement を
      // template 側にも登録する (script visitor に居ても届かない)。
      const templateVisitor: LooseVisitor = {
        VLiteral(node) {
          const lit = node as VueAST.VLiteral;
          report({ text: lit.value, node: lit });
        },
        ...(scriptVisitor as unknown as LooseVisitor),
      };
      return services.defineTemplateBodyVisitor(
        templateVisitor,
        scriptVisitor as unknown as LooseVisitor,
      );
    }

    return scriptVisitor;
  },
};

export default rule;
