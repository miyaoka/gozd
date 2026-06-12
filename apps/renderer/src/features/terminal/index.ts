export { default as TerminalPane } from "./TerminalPane.vue";
export { useTerminalStore } from "./useTerminalStore";
export { applyTerminalTheme, registerThemeCommand } from "./registerThemeCommand";
export { terminalFontFamily, terminalFontSize } from "./terminalConfig";
export { CLAUDE_STATE_ICON } from "./claudeStatus";
export type { ClaudeState, ClaudeStatus } from "./claudeStatus";
export type { HookPayload } from "./rpc";
