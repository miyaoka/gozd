import { generateManifest } from "material-icon-theme";

/**
 * material-icon-theme のマニフェストからアイコン URL を解決する。
 *
 * SSOT は `manifest.iconDefinitions[name].iconPath`。
 * `iconPath` の basename が実 SVG ファイル名と一致するため、ファイル名から逆引きせず
 * iconDefinitions を介して URL を引く。`.clone` サフィックス等の派生規則にも透過的に追従する。
 *
 * 解決優先順位:
 *   ファイル: fileNames → fileExtensions → languageIds → デフォルト
 *   フォルダ: folderNames(Expanded) → デフォルト
 */

const manifest = generateManifest();

/** Vite が SVG をハッシュ付き URL に変換した結果（basename → URL） */
const svgUrlByBasename = new Map<string, string>();
const svgModules = import.meta.glob<string>("/node_modules/material-icon-theme/icons/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
  exhaustive: true,
});
for (const [path, url] of Object.entries(svgModules)) {
  // "/node_modules/material-icon-theme/icons/folder-development.clone.svg" → "folder-development.clone"
  const match = path.match(/\/([^/]+)\.svg$/);
  if (match?.[1]) {
    svgUrlByBasename.set(match[1], url);
  }
}

/** manifest が宣言するアイコン名 → URL */
const iconUrlByName = new Map<string, string>();
for (const [name, def] of Object.entries(manifest.iconDefinitions ?? {})) {
  // iconPath: "./../icons/folder-development.clone.svg" → basename "folder-development.clone"
  const match = def.iconPath.match(/\/([^/]+)\.svg$/);
  const basename = match?.[1];
  if (basename === undefined) continue;
  const url = svgUrlByBasename.get(basename);
  if (url === undefined) continue;
  iconUrlByName.set(name, url);
}

const DEFAULT_FILE_ICON_NAME = manifest.file ?? "file";
const DEFAULT_FOLDER_ICON_NAME = manifest.folder ?? "folder";
const DEFAULT_FOLDER_OPEN_ICON_NAME = manifest.folderExpanded ?? "folder-open";

// material-icon-theme が自身のデフォルトアイコンを解決できない場合は manifest 自体の問題なので即座に失敗させる
function requireIconUrl(name: string): string {
  const url = iconUrlByName.get(name);
  if (url === undefined) {
    throw new Error(`material-icon-theme: icon ${JSON.stringify(name)} not resolvable`);
  }
  return url;
}

const DEFAULT_FILE_ICON_URL = requireIconUrl(DEFAULT_FILE_ICON_NAME);
const DEFAULT_FOLDER_ICON_URL = requireIconUrl(DEFAULT_FOLDER_ICON_NAME);
const DEFAULT_FOLDER_OPEN_ICON_URL = requireIconUrl(DEFAULT_FOLDER_OPEN_ICON_NAME);

const fileNameMap = new Map<string, string>();
for (const [name, icon] of Object.entries(manifest.fileNames ?? {})) {
  fileNameMap.set(name.toLowerCase(), icon);
}

const fileExtensionMap = new Map<string, string>();
for (const [ext, icon] of Object.entries(manifest.fileExtensions ?? {})) {
  fileExtensionMap.set(ext, icon);
}

/**
 * 拡張子 → VS Code 言語 ID のマッピング。
 * languageIds は VS Code の言語 ID がキーだが、ファイラーでは拡張子しかわからないため
 * 拡張子 → 言語 ID → アイコン名 の変換が必要。
 */
const EXTENSION_LANGUAGE_ID_MAP: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  fs: "fsharp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  r: "r",
  lua: "lua",
  dart: "dart",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "sml",
  nim: "nim",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  svelte: "svelte",
  vue: "vue",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sass: "sass",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "svg",
  md: "markdown",
  tex: "tex",
  pdf: "pdf",
  diff: "diff",
  log: "log",
};

const languageIdMap = new Map<string, string>();
for (const [langId, icon] of Object.entries(manifest.languageIds ?? {})) {
  languageIdMap.set(langId, icon);
}

const folderNameMap = new Map<string, string>();
for (const [name, icon] of Object.entries(manifest.folderNames ?? {})) {
  folderNameMap.set(name.toLowerCase(), icon);
}

const folderNameOpenMap = new Map<string, string>();
for (const [name, icon] of Object.entries(manifest.folderNamesExpanded ?? {})) {
  folderNameOpenMap.set(name.toLowerCase(), icon);
}

function resolveFileIconName(fileName: string): string {
  const lower = fileName.toLowerCase();

  const byName = fileNameMap.get(lower);
  if (byName) return byName;

  // 複合拡張子も対応: .test.ts → test.ts → ts
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const byExt = fileExtensionMap.get(ext);
    if (byExt) return byExt;
  }

  const ext = parts[parts.length - 1];
  if (ext) {
    const langId = EXTENSION_LANGUAGE_ID_MAP[ext];
    if (langId) {
      const byLang = languageIdMap.get(langId);
      if (byLang) return byLang;
    }
  }

  return DEFAULT_FILE_ICON_NAME;
}

function resolveFolderIconName(folderName: string, isOpen: boolean): string {
  const lower = folderName.toLowerCase();
  if (isOpen) {
    return folderNameOpenMap.get(lower) ?? DEFAULT_FOLDER_OPEN_ICON_NAME;
  }
  return folderNameMap.get(lower) ?? DEFAULT_FOLDER_ICON_NAME;
}

/** ファイル名から material-icon-theme の SVG URL を返す */
function getFileIconUrl(fileName: string): string {
  return iconUrlByName.get(resolveFileIconName(fileName)) ?? DEFAULT_FILE_ICON_URL;
}

/** フォルダ名から material-icon-theme の SVG URL を返す */
function getFolderIconUrl(folderName: string, isOpen: boolean): string {
  const name = resolveFolderIconName(folderName, isOpen);
  const url = iconUrlByName.get(name);
  if (url !== undefined) return url;
  return isOpen ? DEFAULT_FOLDER_OPEN_ICON_URL : DEFAULT_FOLDER_ICON_URL;
}

export { getFileIconUrl, getFolderIconUrl };
