// CJS に bundle した ESM 依存の `import.meta.url` を、bundle 出力ファイル自身の URL で埋める。
// build.ts が `define` で `import.meta.url` をこの識別子に置き換え、`inject` で本ファイルを
// 注入する（esbuild 公式の手順）。置き換えないと CJS では `import.meta` が空になり、
// モジュール先頭で `createRequire(import.meta.url)` を呼ぶ依存（Claude Agent SDK）が
// 読み込み時点で throw して main が起動しない。
import { pathToFileURL } from "node:url";

export const importMetaUrl = pathToFileURL(__filename).href;
