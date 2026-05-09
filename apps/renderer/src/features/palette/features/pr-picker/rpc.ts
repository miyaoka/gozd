import {
  GitPrListRequest,
  GitPrListResponse,
  GitViewerRequest,
  GitViewerResponse,
} from "@gozd/proto";

import { rpc } from "../../../../shared/rpc";

export const rpcGitPrList = (req: GitPrListRequest) =>
  rpc("/git/prList", req, GitPrListRequest, GitPrListResponse);

export const rpcGitViewer = (req: GitViewerRequest) =>
  rpc("/git/viewer", req, GitViewerRequest, GitViewerResponse);
