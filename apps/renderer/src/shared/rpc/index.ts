// transport と、層をまたいで単一であるべき経路だけを公開する。feature 固有の RPC wrapper は
// 各 feature の rpc.ts に置く。`openExternal` が例外なのは、scheme allowlist の判定点を
// 1 つに保つ契約そのものだから（feature ごとに wrapper を持つと判定が分散する）。
export { rpc } from "./client";
export { isLinkActivation, LINK_OPEN_FAILED_MESSAGE, openExternal } from "./openExternal";
export {
  dispatchMessage,
  initRpcDispatcher,
  onMessage,
  setListenerErrorReporter,
} from "./messages";
