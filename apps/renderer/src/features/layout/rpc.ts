import {
  PickAndOpenRequest,
  PickAndOpenResponse,
  WindowCloseRequest,
  WindowCloseResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcWindowClose = (req: WindowCloseRequest = WindowCloseRequest.create()) =>
  rpc("/window/close", req, WindowCloseRequest, WindowCloseResponse);

export const rpcPickAndOpen = (req: PickAndOpenRequest = PickAndOpenRequest.create()) =>
  rpc("/open/pickAndOpen", req, PickAndOpenRequest, PickAndOpenResponse);
