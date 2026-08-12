// sidebar が使う RPC wrapper。
import {
  LoadAppStateRequest,
  LoadAppStateResponse,
  PickAndOpenResponse,
  SaveAppStateRequest,
  SaveAppStateResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

// native の NSOpenPanel で repo ディレクトリを選んで開く（Add repo ボタン）。
export const rpcPickAndOpen = () => rpc<PickAndOpenResponse>("/open/pickAndOpen", {});

// --- app-state 永続化（sidebar repos / order / collapse の保存） ---

export const rpcAppStateLoad = (req: LoadAppStateRequest) =>
  rpc<LoadAppStateResponse>("/appState/load", req);

export const rpcAppStateSave = (req: SaveAppStateRequest) =>
  rpc<SaveAppStateResponse>("/appState/save", req);
