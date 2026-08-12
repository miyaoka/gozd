import { GitViewerRequest, GitViewerResponse } from "@gozd/rpc";

import { rpc } from "../../../../shared/rpc";

export const rpcGitViewer = (req: GitViewerRequest) => rpc<GitViewerResponse>("/git/viewer", req);
