// HTML preview に実 origin と実 URL 空間を与える配信 scheme。
//
// srcdoc に文字列を流し込む形では、document の base URL が親 (renderer) の URL になるため
// previewed HTML の相対リンク・画像・CSS が原理的に解決しない。origin も opaque になるので
// 親からクリックを傍受することもできない。VS Code の webview が `vscode-file://` を
// `registerFileProtocol` でローカル配信し、iframe に実 URL を load させているのと同じ形にする
// （`platform/protocol/electron-main/protocolMainService.ts`）。
//
// 配信範囲は renderer が明示的に登録した root 配下だけに絞る（VS Code の `addValidFileRoot` /
// `localResourceRoots` と同型）。登録が無い間は何も配信しない。
import { tryCatch } from "@gozd/shared";
import { net, protocol } from "electron";
import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PREVIEW_SCHEME } from "./previewScheme";

/** URL の host 部。path だけを意味的な識別子にするため固定値を置く */
const PREVIEW_HOST = "file";

/**
 * previewed HTML に許す能力。script / frame / form は無効、参照できるのは同 origin
 * （= 登録 root 配下）の asset と data: URI だけに閉じる。previewed HTML はリポジトリ内の
 * 任意ファイルで untrusted なので、実 origin を与える代わりに CSP で能力を落とす。
 */
// リンク遷移の可否は CSP ではなく navigation 防壁 (decideFrameNavigation) が決める
const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "form-action 'none'",
  "frame-src 'none'",
  "script-src 'none'",
  // `<base href>` で subresource の解決先をすり替えられないようにする
  "base-uri 'self'",
].join("; ");

/**
 * 配信を許す root（解決済み prefix）→ それを要求している preview の id 集合。
 *
 * root の寿命を preview の生存期間に紐づける。登録しっぱなしにすると、閉じた preview の root が
 * 残り、別の preview がその root 配下の asset を読めてしまう（VS Code の `addValidFileRoot` が
 * disposable を返して寿命を呼び出し側に持たせているのと同じ理由）。
 */
const rootOwners = new Map<string, Set<string>>();

/** trailing separator を持つ正規化 root。prefix 比較で sibling dir を巻き込まないため */
function rootPrefix(root: string): string {
  const normalized = normalize(resolve(root));
  return normalized.endsWith(sep) ? normalized : `${normalized}${sep}`;
}

/**
 * preview 配信を許す root を登録する。同一 root の重複登録は no-op。
 *
 * root も `realpath` してから登録する。範囲判定は配信時に解決済み path で行うので、root 側を
 * 解決しないと比較の両辺が食い違う。macOS は `/tmp` → `/private/tmp`、`/var` → `/private/var`
 * が symlink なので、`$TMPDIR` や `/tmp` 配下の repo で全配信が 403 になる。
 *
 * 解決に失敗したら throw する。登録できないまま URL を返すと、iframe が load して 403 になり
 * 「空面 + stderr 1 行」で終わる。呼び出し側 (RPC handler) がエラーに変換すれば renderer の
 * トーストまで届く。
 */
export async function addPreviewRoot(root: string, previewId: string): Promise<void> {
  const real = await tryCatch(realpath(root));
  if (!real.ok) {
    throw new Error(`failed to resolve preview root: ${root}: ${String(real.error)}`);
  }
  const prefix = rootPrefix(real.value);
  // 同じ preview が別 root へ移ったときに前の root を残さない
  releasePreviewRoots(previewId);
  const owners = rootOwners.get(prefix) ?? new Set<string>();
  owners.add(previewId);
  rootOwners.set(prefix, owners);
}

/**
 * preview が閉じた / 対象を変えたときに、その preview が要求していた root を手放す。
 * 他の preview がまだ同じ root を要求していれば prefix は残る。
 */
export function releasePreviewRoots(previewId: string): void {
  for (const [prefix, owners] of rootOwners) {
    if (!owners.delete(previewId)) continue;
    if (owners.size === 0) rootOwners.delete(prefix);
  }
}

/**
 * 絶対パスが指定 root の配下か（root 自身は配信対象にしない）。RPC 入口の fail-loud ガードが使う。
 *
 * 配信時の権威的な判定 `isUnderValidRoot` は登録済み prefix 集合と突き合わせる別関数だが、
 * prefix の作り方（`rootPrefix`）は共有する。入口と配信で prefix 規則がずれると「入口は通るが
 * 配信は 403」になるため、規則側を 1 つに保つ。realpath の有無は両者で異なる（入口は未解決
 * パス同士の整合チェック、配信は解決済みパスでの権威的判定）。
 */
export function isWithinRoot(absPath: string, root: string): boolean {
  return normalize(absPath).startsWith(rootPrefix(root));
}

/** 絶対パスが登録 root のいずれかの配下かを判定する（配信時の権威的な判定） */
function isUnderValidRoot(absPath: string): boolean {
  const normalized = normalize(absPath);
  for (const prefix of rootOwners.keys()) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

/** preview URL から配信対象の絶対パスを取り出す。host 不一致・非絶対は undefined */
function previewUrlToPath(url: string): string | undefined {
  const parsed = tryCatch(() => new URL(url));
  if (!parsed.ok) return undefined;
  if (parsed.value.protocol !== `${PREVIEW_SCHEME}:`) return undefined;
  if (parsed.value.hostname !== PREVIEW_HOST) return undefined;
  const decoded = tryCatch(() => decodeURIComponent(parsed.value.pathname));
  if (!decoded.ok) return undefined;
  // pathname は必ず `/` 始まり。POSIX 絶対パスとしてそのまま使う
  return decoded.value.startsWith("/") ? normalize(decoded.value) : undefined;
}

/** 絶対パスから preview URL を組み立てる（renderer が iframe src に使う形） */
export function pathToPreviewUrl(absPath: string): string {
  // path segment ごとに encode する。`#` や `?` を含むファイル名が fragment / query に
  // 化けるのを防ぐ（`/` は区切りとして残す）
  const encoded = absPath.split("/").map(encodeURIComponent).join("/");
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}${encoded}`;
}

/**
 * scheme を standard + secure として宣言する。`app.whenReady()` より前に呼ぶ必要がある
 * （Electron の制約）。standard にしないと origin が opaque になり、相対 URL の解決と
 * 同 origin 判定が成立しない。
 */
export function registerPreviewSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, corsEnabled: false },
    },
  ]);
}

/** protocol handler を登録する。`app.whenReady()` 後に呼ぶ */
export function installPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const path = previewUrlToPath(request.url);
    if (path === undefined) {
      console.error(`[previewProtocol] rejected malformed url: ${request.url}`);
      return new Response(null, { status: 400 });
    }
    // 範囲判定は解決済み path で 1 回だけ行う。登録 root も解決済みなので両辺が揃う。
    // 解決前の path でも判定すると、symlink を含むパス (macOS の /tmp・$TMPDIR) で
    // 両辺が食い違って正常なファイルまで弾く
    const real = await tryCatch(realpath(path));
    if (!real.ok) {
      console.error(`[previewProtocol] realpath failed: ${path}: ${real.error}`);
      return new Response(null, { status: 404 });
    }
    if (!isUnderValidRoot(real.value)) {
      console.error(`[previewProtocol] rejected out-of-root path: ${path} -> ${real.value}`);
      return new Response(null, { status: 403 });
    }
    const read = await tryCatch(readFile(real.value));
    if (!read.ok) {
      console.error(`[previewProtocol] read failed: ${real.value}: ${read.error}`);
      return new Response(null, { status: 404 });
    }
    // MIME は Electron の file: 経路に判定させる。path の URL 化は pathToFileURL が SSOT
    // （`#` や `?` を含むファイル名を素の文字列連結で組むと別パスを指す）
    const type = await tryCatch(net.fetch(pathToFileURL(real.value).href, { method: "HEAD" }));
    if (!type.ok) {
      console.error(`[previewProtocol] content-type probe failed: ${real.value}: ${type.error}`);
    }
    const contentType = type.ok ? (type.value.headers.get("content-type") ?? "") : "";
    return new Response(new Uint8Array(read.value), {
      status: 200,
      headers: {
        "content-type": contentType === "" ? "application/octet-stream" : contentType,
        "content-security-policy": PREVIEW_CSP,
        // 相対参照の CSS / 画像が stale のまま残らないようにする（更新は epoch 付き URL で
        // 再 load するが、subresource は URL が変わらない）
        "cache-control": "no-store",
      },
    });
  });
}
