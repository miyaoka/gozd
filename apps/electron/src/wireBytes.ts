import type { WireBytes } from "@gozd/rpc";

/**
 * ワイヤ (structured clone) に載せるバイト列へ変換する。変換が必要な理由は
 * `@gozd/rpc` の `WireBytes` docstring を参照 (Buffer の共有プール view をそのまま
 * 送ると backing ArrayBuffer ごと複製され、無関係なデータの漏出と過剰転送になる)。
 */
export function toWireBytes(bytes: Buffer): WireBytes {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
