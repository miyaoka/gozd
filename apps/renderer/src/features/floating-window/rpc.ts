// child window の bounds 操作 RPC。renderer 側 API (moveTo / resizeBy) を使わない理由は
// @gozd/rpc の ChildWindowMoveRequest / ChildWindowResizeByRequest の doc 参照
// (Blink キャッシュ由来の高さ破壊・誤差)。
import type {
  ChildWindowMoveRequest,
  ChildWindowMoveResponse,
  ChildWindowResizeByRequest,
  ChildWindowResizeByResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcChildWindowMove = (req: ChildWindowMoveRequest) =>
  rpc<ChildWindowMoveResponse>("/childWindow/move", req);

export const rpcChildWindowResizeBy = (req: ChildWindowResizeByRequest) =>
  rpc<ChildWindowResizeByResponse>("/childWindow/resizeBy", req);

/** childWindowShown push (main → renderer) の payload。push payload 型は @gozd/rpc に
 * 置かない規約 (docs/rpc.md) のため、renderer 側のここが SSOT (main は手組み dict)。
 * undock child window の表示完了 (OS の show event) を通知し、undock 元の後始末
 * (ゴースト解除 / popover close) の合図に使う。 */
export interface ChildWindowShownPayload {
  frameName: string;
}
