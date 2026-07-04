// `gozd-file://localhost/<kind>?dir=<absDir>&path=<relPath>` を `<img src>` に直配信する。
// Swift 版 `FileServerSchemeHandler.swift` の対応物（protocol.handle 版）。
//
// 用途: preview の画像 / SVG 表示。RPC 経由で bytes を運ぶと proto3 の `content: string` が
// バイナリを保持できない問題に当たるため、`<img>` 経路だけ別 scheme で raw bytes を返す。
//
// 経路:
//   - `/fs` : 作業ツリーの実ファイル（resolveSafe containment + validateRelPath safety net）
//   - `/git`: `git show HEAD:<path>` の出力
//   - `/abs`: worktree 外の絶対パス（dir 制約なし。terminal link 等で開いた画像 / SVG 用）
//
// セキュリティ（Swift 版と同じ規律）:
//   - `Access-Control-Allow-Origin` は意図して付けない。`<img>` は passive content として
//     CORS check 対象外で表示でき、cross-origin の `fetch()` / `canvas.getImageData()` は
//     CORS で構造的にブロックされる。「画像は見える、bytes は機械的に取れない」の両立
//   - `/git` 経路は validateRelPath で option 注入 / NUL / 改行 / `..` を弾く
//   - `/abs` は意図的に containment を持たない（worktree 外参照が目的）。git に渡さないため
//     validateRelPath（絶対パスを reject する）は通さない

import { protocol } from "electron";
import { tryCatch } from "@gozd/shared";
import { extname } from "node:path";
import { readFileBytes, readFileBytesAbsolute } from "./fs/fsOps";
import { runGitBuffer } from "./git/gitRunner";
import { validateRelPath } from "./git/gitValidate";

// preview の `<img>` が扱う画像系拡張子のみ。判定不能は application/octet-stream で返し、
// ブラウザが broken-image にする（silent drop 防止の観点で response は必ず返す）
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name) ?? "";
  if (value === "") throw new Error(`missing required query parameter: ${name}`);
  return value;
}

async function fetchBytes(url: URL): Promise<Buffer> {
  const kind = url.pathname.replace(/^\//, "");
  const path = requiredQuery(url, "path");
  if (kind === "fs") {
    validateRelPath(path);
    return readFileBytes(requiredQuery(url, "dir"), path);
  }
  if (kind === "git") {
    validateRelPath(path);
    return runGitBuffer(["show", `HEAD:${path}`], requiredQuery(url, "dir"));
  }
  if (kind === "abs") {
    return readFileBytesAbsolute(path);
  }
  throw new Error(`unknown kind: ${kind} (expected /fs, /git or /abs)`);
}

/** `gozd-file://` protocol handler を default session に登録する。app ready 後に呼ぶ */
export function registerFileServerProtocol(): void {
  protocol.handle("gozd-file", async (request) => {
    const url = new URL(request.url);
    const result = await tryCatch(fetchBytes(url));
    if (!result.ok) {
      console.error(`[FileServer] serve failed for ${request.url}: ${result.error}`);
      return new Response(null, { status: 404 });
    }
    const mime = MIME_BY_EXTENSION[extname(url.searchParams.get("path") ?? "").toLowerCase()];
    return new Response(new Uint8Array(result.value), {
      status: 200,
      headers: {
        "Content-Type": mime ?? "application/octet-stream",
        "Content-Length": String(result.value.byteLength),
      },
    });
  });
}
