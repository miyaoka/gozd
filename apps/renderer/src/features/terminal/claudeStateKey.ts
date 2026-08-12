import { useTerminalStore } from "./useTerminalStore";

/**
 * dir に紐づく Claude 群の state 集合を安定した文字列キーにする reactive getter。
 * 「この dir のエージェント状態が動いた」の変化検知キーとして使う
 * （useGitStatusSync が git status 再取得のトリガに購読する。注入は App.vue）。
 * 集合をキー化するのは、個々の遷移ではなく構成の変化だけを 1 本の watch で拾うため。
 */
export function claudeStateKeyOf(dir: string): string {
  return useTerminalStore()
    .getClaudeStatusesByDir(dir)
    .map((s) => s.state)
    .sort()
    .join(",");
}
