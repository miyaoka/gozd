import type {
  TextSearchCancelRequest,
  TextSearchCancelResponse,
  TextSearchRequest,
  TextSearchResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

/** 全文検索を開始する。マッチは textSearchMatch push で逐次届き、返る Promise は
 *  rg 終了を表す終端信号（limitHit）。 */
export const rpcTextSearch = (req: TextSearchRequest) =>
  rpc<TextSearchResponse>("/search/text", req);

/** 進行中の検索を kill する。 */
export const rpcTextSearchCancel = (req: TextSearchCancelRequest) =>
  rpc<TextSearchCancelResponse>("/search/cancel", req);
