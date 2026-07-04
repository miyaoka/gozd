import {
  GitPrListRequest,
  GitPrListResponse,
  GitViewerRequest,
  GitViewerResponse,
} from "@gozd/rpc";

import { rpc } from "../../../../shared/rpc";

export const rpcGitPrList = (req: GitPrListRequest) => rpc<GitPrListResponse>("/git/prList", req);

export const rpcGitViewer = (req: GitViewerRequest) => rpc<GitViewerResponse>("/git/viewer", req);
