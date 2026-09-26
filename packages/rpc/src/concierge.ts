// 窓口（docs/concierge.md）の RPC 型。

import type { EmptyMessage } from "./common";

/** 窓口のディレクトリを問い合わせる。main は無ければ作ってから返す */
export type ConciergeInfoRequest = EmptyMessage;

export interface ConciergeInfoResponse {
  /** 窓口のディレクトリの絶対パス */
  dir: string;
}
