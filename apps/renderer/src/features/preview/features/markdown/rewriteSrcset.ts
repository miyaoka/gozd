/**
 * `srcset` の各候補の URL を書き換える。書き換えた結果 undefined になった候補は落とし、
 * 候補が残らなければ undefined を返す（呼び出し側は属性を外す）。
 *
 * 候補の区切りは HTML の srcset の解析規則に従う。URL は空白まで続き、末尾のカンマは候補の
 * 区切りとして扱う。URL の途中のカンマ（`data:` の本体等）は区切りにしない。descriptor は
 * 括弧の外にあるカンマまで続く。
 */
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
      let depth = 0;
      while (i < value.length) {
        const c = value[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth <= 0) break;
        i++;
      }
      descriptor = value.slice(descriptorStart, i).trim();
    }

    const rewritten = rewrite(url);
    if (rewritten === undefined) continue;
    candidates.push(descriptor === "" ? rewritten : `${rewritten} ${descriptor}`);
  }
  return candidates.length === 0 ? undefined : candidates.join(", ");
}
