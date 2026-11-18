import type { ClaudeTaskListRequest, ClaudeTaskListResponse } from "@gozd/rpc";
import { rpc } from "../../shared/rpc";

export const rpcClaudeTaskList = (req: ClaudeTaskListRequest) =>
  rpc<ClaudeTaskListResponse>("/claudeSession/listTasks", req);
