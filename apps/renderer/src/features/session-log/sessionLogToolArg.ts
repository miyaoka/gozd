// session log の tool イベント見出しに出す主要引数プレビューの算出。
//
// 代表キーを優先順で 1 つ拾い、最初に見つかった非空 string を採用する。パス系キー
// (file_path / path) は絶対パスが行を占有するため basename だけを表示し、フルパスは
// title (hover) に回す。コマンド等はそのまま (長い場合は表示側で CSS truncate)。

const TOOL_PRIMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url"];
// パス系は basename に縮約する。絶対パスのフルは title に回し、行を占有させない。
const PATH_KEYS = new Set(["file_path", "path"]);

export interface ToolArgPreview {
  /** chip に表示する縮約後テキスト (パスなら basename) */
  label: string;
  /** title (hover) 用のフル値 */
  full: string;
}

/**
 * パス文字列の basename (末尾区切りを除いた最後のセグメント)。
 *
 * `split("/")` は常に string 要素を返すため、末尾区切りのみ ("/" / "//") のときは空文字
 * セグメントになる。空文字は表示できないので元値に倒す (chip が空になるのを防ぐ)。
 */
function basename(path: string): string {
  const segments = path.replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === "" ? path : last;
}

/** input から代表引数を 1 つ選び、表示用 label と hover 用 full を返す。無ければ undefined。 */
export function toolArgPreview(input: Record<string, unknown>): ToolArgPreview | undefined {
  for (const key of TOOL_PRIMARY_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value === "") continue;
    if (PATH_KEYS.has(key)) return { label: basename(value), full: value };
    return { label: value, full: value };
  }
  return undefined;
}
