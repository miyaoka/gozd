export { default as TerminalPane } from "./TerminalPane.vue";
export { useTerminalStore } from "./useTerminalStore";
export { applyTerminalTheme, registerThemeCommand } from "./registerThemeCommand";
export { currentThemeName, terminalFontFamily, terminalFontSize } from "./terminalConfig";
export { CLAUDE_STATE_VISUAL, displayClaudeState, stripClaudeTitlePrefix } from "./claudeStatus";
export type { ClaudeState, ClaudeStatus, ClaudeFxEvent, HookEvent } from "./claudeStatus";
export type { HookPayload } from "./rpc";
