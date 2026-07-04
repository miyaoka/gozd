import type {
  PickAndOpenResponse,
  WindowCloseResponse,
  WindowSetTitleContextRequest,
  WindowSetTitleContextResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcWindowClose = () => rpc<WindowCloseResponse>("/window/close", {});

export const rpcPickAndOpen = () => rpc<PickAndOpenResponse>("/open/pickAndOpen", {});

export const rpcWindowSetTitleContext = (req: WindowSetTitleContextRequest) =>
  rpc<WindowSetTitleContextResponse>("/window/setTitleContext", req);
