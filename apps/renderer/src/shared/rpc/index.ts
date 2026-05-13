// transport のみ公開する。feature 固有の RPC wrapper は各 feature の rpc.ts に置く。
export { rpc } from "./client";
export { dispatchMessage, onMessage } from "./messages";
