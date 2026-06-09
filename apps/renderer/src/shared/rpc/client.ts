// gozd-rpc:// URL Scheme 越しの RPC クライアント。
//
// 設計判断:
//
// 1. **proto3 JSON mapping**。`@gozd/proto` から生成された型の `toJSON` /
//    `fromJSON` で encode / decode する。binary は使わない（ブラウザ側で
//    base64 / Uint8Array が煩雑になるため、性能ボトルネックが見えるまで JSON）
//
// 2. **gozd-rpc://localhost プレフィックス固定**。renderer 側の origin (Vite dev
//    `http://localhost:<port>` / build `gozd-app://localhost`) から見ると
//    `gozd-rpc://localhost` は cross-origin になるが、native 側 `RpcSchemeHandler`
//    が Origin allowlist に基づき `Access-Control-Allow-Origin` を明示 echo するため
//    WebKit の標準 CORS check を pass する。詳細は
//    [docs/spike/2026-06-09-gozd-rpc-cors.md](../../../../../docs/spike/2026-06-09-gozd-rpc-cors.md)
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
