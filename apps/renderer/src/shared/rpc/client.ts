// gozd-rpc:// URL Scheme 越しの RPC クライアント。
//
// 設計判断:
//
// 1. **proto3 JSON mapping**。`@gozd/proto` から生成された型の `toJSON` /
//    `fromJSON` で encode / decode する。binary は使わない（ブラウザ側で
//    base64 / Uint8Array が煩雑になるため、性能ボトルネックが見えるまで JSON）
//
// 2. **gozd-rpc://localhost プレフィックス固定**。WebPage の origin が
//    http (Vite dev) でも gozd-app (本番) でも `Access-Control-Allow-Origin: *`
//    で同じく動くことを spike `170dfa1` で確認済み
//
// 3. **エラーは throw**。HTTP 4xx/5xx は ok=false で fetch は throw しないため、
//    明示的に判定してエラーを投げる。renderer 側は try/catch + tryCatch で扱う

interface Codec<T> {
  toJSON(t: T): unknown;
  fromJSON(j: unknown): T;
}

const RPC_BASE = "gozd-rpc://localhost";

export async function rpc<Req, Resp>(
  path: string,
  req: Req,
  reqCodec: Codec<Req>,
  respCodec: Codec<Resp>,
): Promise<Resp> {
  const res = await fetch(`${RPC_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqCodec.toJSON(req)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${path} failed: ${res.status} ${text}`);
  }
  return respCodec.fromJSON(await res.json());
}
