/**
 * 生 Tailwind palette utility (例: `bg-zinc-800`) と生 palette CSS variable
 * (例: `var(--color-zinc-800)`) を禁止する。
 *
 * gozd は色 token を `apps/renderer/src/assets/main.css` の `@theme` に集約する
 * SSOT 規約で、UI は全て semantic token (`bg-background` / `text-foreground-muted` /
 * `bg-accent` / `var(--color-surface-1)` 等) で書く。生 palette は AI / 人間どちら
 * が書いてもこの規約を破壊するため lint で機械的に止める。
 *
 * ## 検知対象
 *
 * **(a) class utility 形** (string literal 内の `bg-zinc-800` 系):
 *   - Vue template の `class="..."` (static literal、VLiteral 経由)
 *   - JS / TS / Vue script の string literal / template literal (cooked text 部分)
 *   - これにより `:class="'bg-zinc-800'"` / `:class="['bg-zinc-800']"` /
 *     `:class="{ 'bg-zinc-800': x }"` / `:class="cn('bg-zinc-800', ...)"` /
 *     template literal `\`bg-${shade}\`` の static 部分を補足する
 *
 *   tokenization は class string を whitespace で split → 各 token を構造的に
 *   分解 (variants `hover:dark:` / important `!` / base `bg-zinc-800` / opacity
 *   `/50`) → base を `<prefix>-<palette>(-<shade>)?` でパース。regex 1 本で全てを
 *   流すより誤検出が起きにくく、token 境界が明確。
 *
 * **(b) CSS variable 形** (任意の string literal / 任意のファイル text 内の
 * `var(--color-zinc-800)` 系):
 *   - Vue SFC の `<style>` ブロック (Vue parser は <style> 内 CSS の AST を提供
 *     しないため、source 全体に対して regex で raw palette CSS var を検出する)
 *   - class の arbitrary value (`[--md-code-bg:var(--color-zinc-800)]`) 内 var()
 *   - `.css` / `.ts` / `.tsx` ファイル内の同パターン
 *
 *   検知単位は完成形の `var(--color-<palette>-<shade>)` 文字列。tailwind v4 が
 *   palette ごとに自動定義する CSS variable に直接アクセスする経路はすべてこれで
 *   塞ぐ。
 *
 * ## 検知の境界 (false negative / false positive)
 *
 * - 動的補間で utility を構築する (例: `` `bg-${color}-700` `` / `` `bg-zinc-${level}` ``)
 *   形は cooked text が境界で分割されるため検知不可。これは静的解析の構造的限界。
 * - 動的補間で CSS var を構築する (例: `` `var(--color-${palette}-700)` ``) も同じく
 *   検知不可。
 * - `zinc-800` 単独 (utility prefix なし) は data string とみなして検知しない。
 * - main.css の `@theme` ブロック内コメント (`/* (旧 zinc-300) *​/` 等) には raw
 *   palette 名が含まれるが、rule は class utility 形 / CSS var 形でしか検知しない
 *   ため、コメントは素通りする。
 *
 * ## 採用判断
 *
 * - off-the-shelf の Tailwind ESLint plugin (better-tailwindcss / @poupe /
 *   francoismassart) は class 属性 ban を持たない、または CSS ファイル専用 (poupe
 *   は `.css` / `<style>` だけで template には届かない)。
 * - oxlint-tailwindcss は ESLint 互換でなく Vue lint に乗らない。
 * - SSOT が単一 `@theme` ブロックで明確、かつ pattern が固定なので自前で十分。
 */
import type { AST as VueAST } from "vue-eslint-parser";
import type { Rule } from "eslint";

// Tailwind の utility prefix で「色を受ける」もの。
const UTILITY_PREFIX = new Set([
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
]);

// Tailwind の生 palette 名。
const PALETTE = new Set([
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
]);

// `var(--color-<palette>(-<shade>)?)` を完成形で検知する。`var()` の中 / 外
// どちらの形 (`var(--color-zinc-700)` / `var(--color-zinc-700, fallback)`) でも
// 機能するように `)` までは要求しない。
const PALETTE_ARRAY = [...PALETTE].join("|");
const CSS_VAR_RE = new RegExp(
  String.raw`var\(\s*--color-(${PALETTE_ARRAY})(?:-\d+)?\b`,
  "g",
);

interface ParsedUtility {
  /** variant prefix の列 (`hover:dark:` → ["hover", "dark"]) */
  variants: string[];
  important: boolean;
  /** base 部分 (`bg-zinc-700`) */
  base: string;
  /** opacity 修飾子 (`/50`) */
  opacity: string | undefined;
}

/**
 * class 属性値を whitespace で utility token に split し、各 token を
 * variants / important / base / opacity に構造分解する。AST に対応する操作
 * (utility 文法のパース) を 1 token ずつ実行することで、regex 1 本で文字列全体を
 * scan するより境界が明確になる。
 */
function tokenizeClassString(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
}

function parseUtility(token: string): ParsedUtility | undefined {
  const variantParts = token.split(":");
  const tail = variantParts.pop();
  if (tail === undefined || tail.length === 0) return undefined;
  const variants = variantParts;
  const important = tail.startsWith("!");
  const baseAndOpacity = important ? tail.slice(1) : tail;
  const slashIdx = baseAndOpacity.indexOf("/");
  const base = slashIdx >= 0 ? baseAndOpacity.slice(0, slashIdx) : baseAndOpacity;
  const opacity = slashIdx >= 0 ? baseAndOpacity.slice(slashIdx + 1) : undefined;
  return { variants, important, base, opacity };
}

/**
 * base 部分が `<utility-prefix>-<palette>(-<shade>)?` 形か判定し、該当時に
 * 整形済みの違反文字列 (`bg-zinc-700` / `bg-zinc-700/50`) を返す。
 */
function detectRawPaletteUtility(parsed: ParsedUtility): string | undefined {
  // base を `prefix` と「残り」で 1 段だけ split (例: `bg-zinc-700` → bg / zinc-700)。
  // arbitrary value / negative prefix 等の特殊形は除外 (今回の sweep 対象ではない)。
  const firstDash = parsed.base.indexOf("-");
  if (firstDash < 0) return undefined;
  const prefix = parsed.base.slice(0, firstDash);
  if (!UTILITY_PREFIX.has(prefix)) return undefined;
  const rest = parsed.base.slice(firstDash + 1);
  // rest の構造: `<palette>` (white/black 等) or `<palette>-<shade>` (zinc-700 等)。
  // semantic token (foreground-muted / border-strong / accent-strong 等) は palette
  // 名から始まらないので素通りする。
  const restMatch = rest.match(/^([a-z]+)(?:-(\d+))?$/);
  if (restMatch === null) return undefined;
  const palette = restMatch[1];
  if (!PALETTE.has(palette)) return undefined;
  const violation = parsed.opacity === undefined ? parsed.base : `${parsed.base}/${parsed.opacity}`;
  return violation;
}

type ReportNode = Rule.Node | VueAST.VLiteral;

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "生 Tailwind palette (`bg-zinc-800` / `var(--color-zinc-800)` 等) を禁止し、`@theme` 定義の semantic token を強制する",
    },
    messages: {
      rawPaletteClass:
        "Raw Tailwind palette utility `{{match}}` is forbidden. Use a semantic token defined in `apps/renderer/src/assets/main.css` (`bg-background` / `text-foreground-muted` / `bg-accent` 等). See `.claude/skills/gozd-ui/SKILL.md`.",
      rawPaletteCssVar:
        "Raw Tailwind palette CSS variable `{{match}}` is forbidden. Use a semantic token (`var(--color-surface-1)` / `var(--color-foreground)` / `var(--color-info)` 等) defined in `apps/renderer/src/assets/main.css`. See `.claude/skills/gozd-ui/SKILL.md`.",
    },
    schema: [],
  },
  create(context) {
    function reportClassString(text: string, node: ReportNode) {
      for (const token of tokenizeClassString(text)) {
        const parsed = parseUtility(token);
        if (parsed === undefined) continue;
        const violation = detectRawPaletteUtility(parsed);
        if (violation === undefined) continue;
        context.report({
          node: node as Rule.Node,
          messageId: "rawPaletteClass",
          data: { match: violation },
        });
      }
    }

    function reportCssVar(text: string, node: ReportNode) {
      for (const match of text.matchAll(CSS_VAR_RE)) {
        context.report({
          node: node as Rule.Node,
          messageId: "rawPaletteCssVar",
          data: { match: match[0] + ")" },
        });
      }
    }

    // CSS variable 違反 (`var(--color-zinc-*)` 系) は **常に source text 全体に
    // 対する Program visitor からのみ** 報告する。Literal / TemplateElement / VLiteral
    // からも報告すると、template body の class arbitrary value (`[--md-code-bg:var(--color-zinc-700)]`)
    // のように複数 visitor が同じ違反を踏み、二重報告になる。class utility 形は
    // Literal / VLiteral 側でのみ報告する (token 単位の境界が必要なため)。
    const scriptVisitor: Rule.RuleListener = {
      Literal(node) {
        if (typeof node.value !== "string") return;
        reportClassString(node.value, node);
      },
      TemplateElement(node) {
        reportClassString(node.value.cooked ?? node.value.raw, node);
      },
      Program(node) {
        const text = context.sourceCode.text;
        if (text.length === 0) return;
        reportCssVar(text, node as unknown as Rule.Node);
      },
    };

    // vue-eslint-parser で parse された Vue SFC は `parserServices.defineTemplateBodyVisitor`
    // を経由して `<template>` AST に到達できる。`<template>` 内 VLiteral (static class) と、
    // template body 配下に居る JS 式の Literal / TemplateElement の両方を見る。
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
      const templateVisitor: LooseVisitor = {
        VLiteral(node) {
          const lit = node as VueAST.VLiteral;
          reportClassString(lit.value, lit);
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
