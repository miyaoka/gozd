/**
 * トースト詳細パネル用に `cause` を文字列化するヘルパー。
 *
 * Error の `cause` chain を辿って再帰展開する: 1 段目は `<name>: <message>` + stack、
 * 2 段目以降は `\n\nCaused by: ` をプレフィックスして並べる。これにより aggregate
 * Error が `cause` に first failure を持つパターン (`useFsWatchSync` の `runOneSyncPass`
 * など複数 caller で使う) で、トースト詳細 1 つだけで「集約 message + 根本原因 + stack」
 * が全部読める。
 *
 * `NotificationToastItem.vue` から SFC 外に切り出した理由: chain walker は純関数で
 * bun test から DOM 無しで直接呼べる方が回帰が固い。SFC 側は `computed` で薄く呼ぶだけ。
 *
 * V8 と JavaScriptCore で `Error.stack` のフォーマットが違う点も中で正規化する:
 * - V8: 先頭行に `<name>: <message>` を含む（multi-line message ならその 1 行目のみ）
 * - JavaScriptCore: フレーム列のみ、`<name>: <message>` 行を持たない
 *
 * `name:` で始まる先頭行は V8 形式とみなして捨て、`head` を毎回前置する。これで多段の
 * stack でも先頭行のフォーマットが揃う。
 */
import { tryCatch } from "@gozd/shared";

/** cause chain の最大再帰深度。循環参照や悪意ある cause 設定で無限ループに陥らない安全弁。 */
const MAX_CAUSE_DEPTH = 10;

/** 1 つの cause 値（Error / string / その他）を 1 ブロックの文字列にする。 */
function formatSingleCause(cause: unknown): string {
  if (cause instanceof Error) {
    const head = `${cause.name}: ${cause.message}`;
    const stack = cause.stack;
    if (stack === undefined || stack === "") return head;
    const [firstLine = "", ...rest] = stack.split("\n");
    const frames = firstLine.startsWith(`${cause.name}:`) ? rest : [firstLine, ...rest];
    const body = frames.join("\n");
    return body === "" ? head : `${head}\n${body}`;
  }
  if (typeof cause === "string") return cause;
  return safeStringify(cause);
}

/** 循環参照や toString が壊れたオブジェクトでもトースト描画を壊さないように整形する。 */
function safeStringify(value: unknown): string {
  // String() は Symbol.toPrimitive / toString / valueOf が壊れている時に throw する
  const stringResult = tryCatch(() => String(value));
  if (stringResult.ok && stringResult.value !== "[object Object]") {
    return stringResult.value;
  }
  // Object 系で String() が "[object Object]" になるケースは JSON 整形を試す
  const seen = new WeakSet<object>();
  const jsonResult = tryCatch(() =>
    JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      },
      2,
    ),
  );
  if (jsonResult.ok && jsonResult.value !== undefined) return jsonResult.value;
  // どちらも失敗 / undefined を返す場合は prototype-free な型表記にフォールバック。
  // Symbol.toStringTag の getter が throw するケースに備えてこれも tryCatch で包む
  const tagResult = tryCatch(() => Object.prototype.toString.call(value));
  return tagResult.ok ? tagResult.value : "[unrepresentable cause]";
}

/**
 * cause が Error なら `cause.cause` を辿って chain 全体を文字列化する。
 * Error 以外（string / object など）が来た時点で chain walker は終了する。
 * 循環参照は `WeakSet` で検出して同じ Error に再到達したら止める。
 */
export function formatCauseChain(initial: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<Error>();
  let current: unknown = initial;
  let depth = 0;
  while (current !== undefined && depth < MAX_CAUSE_DEPTH) {
    if (current instanceof Error) {
      if (seen.has(current)) {
        parts.push("[Circular cause]");
        break;
      }
      seen.add(current);
    }
    parts.push(formatSingleCause(current));
    if (current instanceof Error) {
      current = current.cause;
      depth++;
    } else {
      break;
    }
  }
  return parts.join("\n\nCaused by: ");
}
