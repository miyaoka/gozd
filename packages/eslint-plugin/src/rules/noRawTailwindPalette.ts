/**
 * 生 Tailwind palette (`bg-zinc-800` / `var(--color-zinc-800)` 等) を禁止し、
 * `apps/renderer/src/assets/main.css` の `@theme` で定義した semantic token
 * (`bg-background` / `text-foreground-low` / `bg-primary` 等) を強制する。
 *
 * AI / 人間どちらも、生 palette を使うと semantic 設計が崩壊するため build
 * error にする。
 *
 * 検出 2 系統:
 *   - utility class 形 (`(variant?:)*(!?)(kind)-(palette)-(shade)(/alpha)?`)
 *     → 文字列 / Vue VLiteral / template literal の cooked text を tokenize
 *   - CSS variable 形 (`var(--color-{palette}-{shade})`)
 *     → Program の sourceText を regex 走査 (Vue <style> / arbitrary value 内も対象)
 *
 * 検出しないもの (構造的限界):
 *   - 動的補間 (`` `bg-${color}-700` ``): 静的 cooked text に utility 形が現れない
 *   - コメント内の例示 (utility 経路): コメントは Literal にならず素通り
 *
 * 検出するが false positive 経路:
 *   - sourceText scan は code / doc / markdown コメント内の `var(--color-zinc-N)`
 *     を例示として書いても拾う。token migration / palette 説明では palette 名と
 *     shade を分離して書く (例: "color-zinc-" の説明 + 別行で shade)
 */
import type { Rule } from "eslint";
import type { AST as VueAST } from "vue-eslint-parser";

type Literal = Rule.Node & { type: "Literal" };
type TemplateElement = Rule.Node & {
  type: "TemplateElement";
  value: { cooked?: string | null; raw: string };
};

/* Tailwind 標準 color utility prefix (color を取る utility のみ)。
 * margin / padding 等の non-color utility は対象外 */
const UTILITY_PREFIX = new Set([
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "outline",
  "decoration",
  "placeholder",
  "caret",
  "divide",
  "from",
  "via",
  "to",
  "shadow",
  "accent",
]);

/* Tailwind 標準 palette 名 (shade 番号を伴う chromatic / grayscale 全 hue) +
 * 単独で utility になる shade なし palette (white / black) */
const PALETTE = new Set([
  "zinc",
  "neutral",
  "stone",
  "gray",
  "slate",
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
  "white",
  "black",
]);

/** utility class 形を 1 個 parse して violation token を返す。なければ undefined */
function detectClassViolation(token: string): string | undefined {
  /* variant prefix + bang を剥がす。variant は Tailwind v4 の bracket variant
   * (`data-[state=open]:` / `peer-[…]:` / `aria-[…]:` / `[&_li]:` 等) を含む
   * 任意 prefix + `:`。bracket は内側に任意文字 ( `[a-z-]+:` だけだと `[` で
   * 落ちる ) を含むため、`[^:]+:` で 1 階層ずつ消費する */
  const stripped = token.replace(/^(?:[^:]+:)*!?/, "");
  const slashAt = stripped.indexOf("/");
  const base = slashAt === -1 ? stripped : stripped.slice(0, slashAt);
  const alpha = slashAt === -1 ? "" : stripped.slice(slashAt);

  /* base = `<kind>-<palette>(-<shade>)?` */
  const firstDash = base.indexOf("-");
  if (firstDash === -1) return undefined;
  const kind = base.slice(0, firstDash);
  if (!UTILITY_PREFIX.has(kind)) return undefined;
  const rest = base.slice(firstDash + 1);
  const m = rest.match(/^([a-z]+)(?:-(\d+))?$/);
  if (m === null) return undefined;
  const palette = m[1];
  if (!PALETTE.has(palette)) return undefined;
  return `${base}${alpha}`;
}

/** sourceText 全体から `var(--color-<palette>-<shade>?)` を抽出 */
const CSS_VAR_RE = /var\(--color-([a-z]+)(?:-(\d+))?\)/g;

/** sourceText 全体から primitive CSS var (`var(--<palette>-<step>)` / `var(--<palette>-a<step>)`)
 * を抽出。primitive を semantic layer 経由せず直接参照すると AI が 3-tier を bypass する。
 * Tier 1 primitives (@gozd/design-tokens) のみ列挙する。Tier 2 alias 名 (graph-lane 等)
 * は混ぜない */
const PRIMITIVE_VAR_RE = /var\(--(gray|blue|red|green|amber|orange)-a?(\d+)\)/g;

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "生 Tailwind palette (`bg-zinc-800` / `var(--color-zinc-800)` 等) を禁止し、`@theme` 定義の semantic token を強制する",
    },
    messages: {
      rawPaletteClass:
        "Raw Tailwind palette utility `{{match}}` is forbidden. Use a semantic token (`bg-background` / `text-foreground-low` / `bg-primary` 等) defined in `apps/renderer/src/assets/main.css`. See `.claude/skills/gozd-ui/SKILL.md`.",
      rawPaletteCssVar:
        "Raw Tailwind palette CSS variable `{{match}}` is forbidden. Use a semantic token (`var(--color-panel)` / `var(--color-foreground)` 等) defined in `apps/renderer/src/assets/main.css`. See `.claude/skills/gozd-ui/SKILL.md`.",
      primitiveVar:
        "Primitive CSS variable `{{match}}` is forbidden. Use a semantic alias (`var(--color-panel)` / `var(--color-foreground)` 等) instead of referencing primitives directly. The 3-tier system requires going through semantic aliases. See `.claude/skills/gozd-ui/SKILL.md`.",
    },
    schema: [],
  },
  create(context) {
    function checkString(text: string, node: Rule.Node | VueAST.VLiteral): void {
      /* whitespace 分割で utility 候補を得る */
      for (const token of text.split(/\s+/)) {
        if (token === "") continue;
        const violation = detectClassViolation(token);
        if (violation === undefined) continue;
        context.report({
          node: node as Rule.Node,
          messageId: "rawPaletteClass",
          data: { match: violation },
        });
      }
    }

    /* script AST (Literal / TemplateElement / Program) を walk する listener。
     * Vue SFC でも script block / sourceText scan はこの listener が処理する */
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
      /* Program 1 回だけ走らせて sourceText 全体を scan (CSS var 形検出)。
       * Vue SFC では `<script>` 不在でも vue-eslint-parser が空 Module を Program
       * として常に組み立てるため、`<style>` 内 / template arbitrary value 内の
       * CSS var もここで拾える */
      Program(node) {
        const text = context.sourceCode.text;
        let m: RegExpExecArray | null;
        CSS_VAR_RE.lastIndex = 0;
        while ((m = CSS_VAR_RE.exec(text)) !== null) {
          const palette = m[1];
          if (!PALETTE.has(palette)) continue;
          context.report({
            node,
            messageId: "rawPaletteCssVar",
            data: { match: m[0] },
          });
        }
        /* primitive CSS var (var(--gray-3) / var(--blue-9) 等) 直参照を弾く。
         * semantic alias (var(--color-panel) 等) 経由を強制 */
        PRIMITIVE_VAR_RE.lastIndex = 0;
        while ((m = PRIMITIVE_VAR_RE.exec(text)) !== null) {
          context.report({
            node,
            messageId: "primitiveVar",
            data: { match: m[0] },
          });
        }
      },
    };

    /* Vue SFC の template body AST は script AST と別系統で、
     * `parserServices.defineTemplateBodyVisitor` を通してのみ walk できる。
     * 通常 listener に `"VAttribute > VLiteral"` を書いても発火しない (公式 docs:
     * vuejs/vue-eslint-parser README) */
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
          /* plain attribute value (class="..." の右辺) */
          "VAttribute > VLiteral"(node) {
            checkString((node as VueAST.VLiteral).value, node);
          },
          /* `:class` / `:style` binding 内の JS string literal は VExpressionContainer
           * 配下の Literal として template body AST にぶら下がる。script visitor の
           * Literal は <script> 内しか拾わないため、template visitor 側でも個別に発火 */
          Literal(node) {
            const lit = node as Literal;
            if (typeof lit.value !== "string") return;
            checkString(lit.value, lit);
          },
          /* template literal (`` `bg-${x}` ``) の cooked 部分 */
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
