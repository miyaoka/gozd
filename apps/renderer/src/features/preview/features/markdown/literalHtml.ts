import type { MarkedExtension } from "marked";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * 本文中の HTML を要素にせず、書かれた文字のまま出す marked extension。ブロックの HTML も
 * インラインのタグも marked の html renderer を通るため、ここ 1 か所で両方に効く。
 */
export const literalHtmlExtension: MarkedExtension = {
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
};
