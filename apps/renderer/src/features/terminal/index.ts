export { default as SplitResizeHandle } from "./SplitResizeHandle.vue";
export { default as TerminalLeaf } from "./TerminalLeaf.vue";
export { useTerminalStore } from "./useTerminalStore";
export type { ClaudeState, ClaudeStatus } from "./claudeStatus";
export { registerTerminalCommands } from "./registerTerminalCommands";
export {
  collectLeafIds,
  flattenHandles,
  leafIdToAreaName,
  TILE_GAP,
  tileGridTemplate,
  treeToGridTemplate,
} from "./splitTree";
export type { HandlePosition, PixelRect } from "./splitTree";
