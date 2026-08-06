// my-work feature の RPC wrapper。ワイヤ型をそのまま feature 内部表現として使う。
import type { GitMyWorkRequest, GitMyWorkResponse } from "@gozd/rpc";
import { rpc } from "../../shared/rpc";

export const rpcGitMyWork = (req: GitMyWorkRequest) => rpc<GitMyWorkResponse>("/git/myWork", req);
