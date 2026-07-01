import { generateManifest, type Manifest } from "material-icon-theme";
import { buildIconUrlByName } from "./iconUrlMap";

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

function requireManifestKey(manifest: Manifest, key: "file" | "folder" | "folderExpanded"): string {
  const value = manifest[key];
  if (value === undefined) {
    throw new Error(`material-icon-theme: manifest.${key} is undefined`);
  }
  return value;
}

function requireIconUrl(iconUrlByName: Map<string, string>, name: string): string {
  const url = iconUrlByName.get(name);
  if (url === undefined) {
    throw new Error(`material-icon-theme: icon ${JSON.stringify(name)} not resolvable`);
  }
  return url;
}

interface IconMaps {
  iconUrlByName: Map<string, string>;
  defaultFileIconName: string;
  defaultFolderIconName: string;
  defaultFolderOpenIconName: string;
  fileNameMap: Map<string, string>;
  fileExtensionMap: Map<string, string>;
  languageIdMap: Map<string, string>;
  folderNameMap: Map<string, string>;
  folderNameOpenMap: Map<string, string>;
}

/**
 * `import.meta.glob` は Vite 専用構文で、`bun test` 環境では未定義のため呼び出すと例外になる。
 * barrel 経由でこのモジュールが評価されるだけで（`getFileIconUrl` を実際に使わなくても）
 * 例外になるのを避けるため、初回呼び出し時まで評価を遅延する。
 */
function buildIconMaps(): IconMaps {
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
    const [, basename] = path.match(/\/([^/]+)\.svg$/) ?? [];
    if (basename === undefined) {
      throw new Error(
        `material-icon-theme: cannot extract basename from SVG path ${JSON.stringify(path)}`,
      );
    }
    svgUrlByBasename.set(basename, url);
  }

  const iconUrlByName = buildIconUrlByName(manifest.iconDefinitions ?? {}, svgUrlByBasename);

  const fileNameMap = new Map<string, string>();
  for (const [name, icon] of Object.entries(manifest.fileNames ?? {})) {
    fileNameMap.set(name.toLowerCase(), icon);
  }

  const fileExtensionMap = new Map<string, string>();
  for (const [ext, icon] of Object.entries(manifest.fileExtensions ?? {})) {
    fileExtensionMap.set(ext, icon);
  }

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

  return {
    iconUrlByName,
    defaultFileIconName: requireManifestKey(manifest, "file"),
    defaultFolderIconName: requireManifestKey(manifest, "folder"),
    defaultFolderOpenIconName: requireManifestKey(manifest, "folderExpanded"),
    fileNameMap,
    fileExtensionMap,
    languageIdMap,
    folderNameMap,
    folderNameOpenMap,
  };
}

let iconMaps: IconMaps | undefined;
function getIconMaps(): IconMaps {
  if (iconMaps === undefined) {
    iconMaps = buildIconMaps();
  }
  return iconMaps;
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

function resolveFileIconName(maps: IconMaps, fileName: string): string {
  const lower = fileName.toLowerCase();

  const byName = maps.fileNameMap.get(lower);
  if (byName !== undefined) return byName;

  // 複合拡張子も対応: .test.ts → test.ts → ts
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const byExt = maps.fileExtensionMap.get(ext);
    if (byExt !== undefined) return byExt;
  }

  const [ext = ""] = parts.slice(-1);
  if (ext !== "") {
    const langId = EXTENSION_LANGUAGE_ID_MAP[ext];
    if (langId !== undefined) {
      const byLang = maps.languageIdMap.get(langId);
      if (byLang !== undefined) return byLang;
    }
  }

  return maps.defaultFileIconName;
}

function resolveFolderIconName(maps: IconMaps, folderName: string, isOpen: boolean): string {
  const lower = folderName.toLowerCase();
  if (isOpen) {
    return maps.folderNameOpenMap.get(lower) ?? maps.defaultFolderOpenIconName;
  }
  return maps.folderNameMap.get(lower) ?? maps.defaultFolderIconName;
}

/** ファイル名から material-icon-theme の SVG URL を返す */
function getFileIconUrl(fileName: string): string {
  const maps = getIconMaps();
  return requireIconUrl(maps.iconUrlByName, resolveFileIconName(maps, fileName));
}

/** フォルダ名から material-icon-theme の SVG URL を返す */
function getFolderIconUrl(folderName: string, isOpen: boolean): string {
  const maps = getIconMaps();
  return requireIconUrl(maps.iconUrlByName, resolveFolderIconName(maps, folderName, isOpen));
}

export { getFileIconUrl, getFolderIconUrl };
