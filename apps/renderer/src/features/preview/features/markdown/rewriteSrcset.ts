/**
 * `srcset` の各候補の URL を書き換える。書き換えた結果 undefined になった候補は落とし、
 * 候補が残らなければ undefined を返す（呼び出し側は属性を外す）。
 *
 * 候補の区切りは HTML の srcset の解析規則に従う。URL は空白まで続き、末尾のカンマは候補の
 * 区切りとして扱う。URL の途中のカンマ（`data:` の本体等）は区切りにしない。descriptor は
 * 括弧の外にあるカンマまで続く（括弧は入れ子にならない）。
 *
 * 出力する descriptor は文法に合うトークン（`<整数>w` / `<数>x` / `<整数>h`）だけを組み直したもので、
 * 合わない候補は落とす。解析の細部がブラウザとずれても、URL 以外の生の文字列を出力に残さなければ、
 * ブラウザが別の位置を URL として読むことはない。
 */

const DESCRIPTOR_RE = /^(?:\d+w|\d+h|(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?x)$/i;

export function rewriteSrcset(
  value: string,
  rewrite: (url: string) => string | undefined,
): string | undefined {
  const candidates: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;

    const urlStart = i;
    while (i < value.length && !/\s/.test(value[i])) i++;
    let url = value.slice(urlStart, i);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const descriptorStart = i;
      let inParens = false;
      while (i < value.length) {
        const c = value[i];
        if (c === "(") inParens = true;
        else if (c === ")") inParens = false;
        else if (c === "," && !inParens) break;
        i++;
      }
      descriptor = value.slice(descriptorStart, i).trim();
    }

    const tokens = descriptor === "" ? [] : descriptor.split(/\s+/);
    if (!tokens.every((token) => DESCRIPTOR_RE.test(token))) continue;
    const rewritten = rewrite(url);
    if (rewritten === undefined) continue;
    candidates.push([rewritten, ...tokens].join(" "));
  }
  return candidates.length === 0 ? undefined : candidates.join(", ");
}
