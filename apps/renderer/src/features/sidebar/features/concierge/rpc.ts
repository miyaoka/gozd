import type { ConciergeInfoRequest, ConciergeInfoResponse } from "@gozd/rpc";

import { rpc } from "../../../../shared/rpc";

// 窓口のディレクトリ。main は無ければ作ってから返す
export const rpcConciergeInfo = (req: ConciergeInfoRequest) =>
  rpc<ConciergeInfoResponse>("/concierge/info", req);
