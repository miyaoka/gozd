/**
 * セッションログ表示 dialog の open state を保持する module singleton。
 *
 * `useTaskEditing` と同じく Task オブジェクトではなく必要最小の値だけ保持する。
 * sessionId はログファイルの glob 解決キー、title は dialog ヘッダの表示用、
 * worktreePath は ~/.claude/projects/<encoded>/ を組み立てるための cwd ベース
 * (`useSessionLogLive` が JSONL 未生成な race を捌くために必要)。
 */
import { ref } from "vue";

type SessionLogContext = {
  sessionId: string;
  title: string;
  worktreePath: string;
};

const context = ref<SessionLogContext | undefined>(undefined);

export function useSessionLogViewer() {
  function open(sessionId: string, title: string, worktreePath: string) {
    context.value = { sessionId, title, worktreePath };
  }
  function close() {
    context.value = undefined;
  }
  return { context, open, close };
}
