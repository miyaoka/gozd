import { type Highlighter, type ShikiTransformer, createHighlighter } from "shiki";

let highlighter: Highlighter | undefined;
let initPromise: Promise<Highlighter> | undefined;

/** 拡張子 → Shiki 言語 ID のマッピング */
const EXTENSION_LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
};

/** ファイル名から言語 ID を推定 */
function detectLang(filePath: string): string | undefined {
  const fileName = filePath.split("/").pop() ?? "";
  // 拡張子なしのファイル名マッチ（Dockerfile, Makefile 等）
  const FILENAME_LANG_MAP: Record<string, string> = {
    Dockerfile: "dockerfile",
    Makefile: "makefile",
  };
  const fileNameMatch = FILENAME_LANG_MAP[fileName];
  if (fileNameMatch) return fileNameMatch;

  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  return EXTENSION_LANG_MAP[ext];
}

/** Shiki インスタンスを遅延初期化して返す */
async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;

  initPromise = createHighlighter({
    themes: ["github-dark"],
    langs: Object.values(EXTENSION_LANG_MAP),
  });

  highlighter = await initPromise;
  return highlighter;
}

/** コードをハイライトして HTML 文字列を返す。言語不明ならプレーンテキストを返す */
async function highlight(code: string, filePath: string): Promise<string | undefined> {
  const lang = detectLang(filePath);
  if (!lang) return undefined;

  const h = await getHighlighter();
  // ハイライタの loaded langs に含まれない場合はスキップ
  const loadedLangs = h.getLoadedLanguages();
  if (!loadedLangs.includes(lang)) return undefined;

  const lineNumberTransformer: ShikiTransformer = {
    line(node, line) {
      node.properties["data-line"] = line;
    },
  };

  return h.codeToHtml(code, {
    lang,
    theme: "github-dark",
    transformers: [lineNumberTransformer],
  });
}

export { highlight };
