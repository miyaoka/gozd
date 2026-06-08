/**
 * セッションログ表示 dialog の open state を保持する module singleton。
 *
 * `useTaskEditing` と同じく Task オブジェクトではなく必要最小の値だけ保持する。
 * sessionId はログファイルの解決キー、title は dialog ヘッダの表示用。
 */
import { ref } from "vue";

type SessionLogContext = {
  sessionId: string;
  title: string;
};

const context = ref<SessionLogContext | undefined>(undefined);

export function useSessionLogViewer() {
  function open(sessionId: string, title: string) {
    context.value = { sessionId, title };
  }
  function close() {
    context.value = undefined;
  }
  return { context, open, close };
}
