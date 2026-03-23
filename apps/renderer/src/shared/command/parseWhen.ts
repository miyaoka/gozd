/**
 * VS Code 互換の when 条件文字列パーサー。
 *
 * 構文:
 *   expr     = orExpr
 *   orExpr   = andExpr ("||" andExpr)*
 *   andExpr  = atom ("&&" atom)*
 *   atom     = "!" atom | contextKey
 *
 * VS Code と同様に括弧はサポートしない。
 * "&&" は "||" より結合が強い。
 *
 * 例: "terminalFocus && !previewVisible || otherKey"
 *   → or(and(key("terminalFocus"), not(key("previewVisible"))), key("otherKey"))
 */
import type { ContextKey, ContextMap, When } from "./types";

/** 既知の context key 名の集合（型安全性の担保） */
const KNOWN_KEYS = new Set<string>(
  Object.keys({
    terminalFocus: true,
    previewVisible: true,
    commandPaletteVisible: true,
    inputFocused: true,
  } satisfies ContextMap),
);

function isContextKey(name: string): name is ContextKey {
  return KNOWN_KEYS.has(name);
}

/**
 * when 条件文字列を When AST に変換する。
 * undefined / 空文字列は undefined を返す（常に true）。
 */
export function parseWhen(input: string | undefined): When | undefined {
  if (input === undefined || input.trim() === "") return undefined;

  const tokens = tokenize(input);
  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(): string {
    const token = tokens[pos];
    if (token === undefined) {
      throw new Error(`Unexpected end of when expression: "${input}"`);
    }
    pos++;
    return token;
  }

  function parseOr(): When {
    const first = parseAnd();
    const values: When[] = [first];

    while (peek() === "||") {
      consume();
      values.push(parseAnd());
    }

    if (values.length === 1) return first;
    return { type: "or", values };
  }

  function parseAnd(): When {
    const first = parseAtom();
    const values: When[] = [first];

    while (peek() === "&&") {
      consume();
      values.push(parseAtom());
    }

    if (values.length === 1) return first;
    return { type: "and", values };
  }

  function parseAtom(): When {
    const token = peek();

    if (token === "!") {
      consume();
      return { type: "not", value: parseAtom() };
    }

    const name = consume();
    if (!isContextKey(name)) {
      throw new Error(`Unknown context key: "${name}" in "${input}"`);
    }
    return { type: "key", key: name };
  }

  const result = parseOr();

  if (pos < tokens.length) {
    throw new Error(`Unexpected token "${tokens[pos]}" in "${input}"`);
  }

  return result;
}

/** when 文字列をトークン列に分割する */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < input.length) {
    // 空白スキップ
    if (input[i] === " " || input[i] === "\t") {
      i++;
      continue;
    }

    // 演算子
    if (input[i] === "&" && input[i + 1] === "&") {
      tokens.push("&&");
      i += 2;
      continue;
    }
    if (input[i] === "|" && input[i + 1] === "|") {
      tokens.push("||");
      i += 2;
      continue;
    }
    if (input[i] === "!") {
      tokens.push("!");
      i++;
      continue;
    }

    // 識別子（context key 名）
    const start = i;
    while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
      i++;
    }
    if (i === start) {
      throw new Error(`Unexpected character "${input[i]}" in "${input}"`);
    }
    tokens.push(input.slice(start, i));
  }

  return tokens;
}
