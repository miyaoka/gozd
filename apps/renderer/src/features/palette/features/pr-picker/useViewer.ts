/**
 * `gh api user --jq .login` の結果を session 中 1 回だけ取得して使い回す module singleton。
 *
 * viewer (認証中ユーザー login) は cwd に依存せず session 中ほぼ不変なため、PR / Issue
 * picker を開くたびに RPC を発射すると無駄な gh REST 1 を消費する。lazy + 共有キャッシュで
 * 1 セッション 1 回に収束させる。
 *
 * 在席ユーザーが CLI で再認証する等のレアケースでは stale になりうるが、アプリ再起動で
 * 復旧する範疇として許容する。
 *
 * 戻り値は `string | undefined` で、成功と失敗を区別可能にする。`""` を fallback として
 * 返さないのは、login が空であること自体が成功シグナルとして意味を持たないからで、
 * 呼び出し側で「未取得状態の degraded UI」を明示分岐させるため。
 */
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../../../shared/notification";
import { ghErrorMessage } from "./ghError";
import { rpcGitViewer } from "./rpc";

let cached: string | undefined;
let inFlight: Promise<string | undefined> | undefined;

/** dir はソケットコンテキスト用に任意の有効な path を渡す。viewer の戻り値自体は dir に依存しない。 */
export async function fetchViewer(dir: string): Promise<string | undefined> {
  if (cached !== undefined) return cached;
  if (inFlight !== undefined) return inFlight;
  const notify = useNotificationStore();
  inFlight = (async () => {
    const result = await tryCatch(rpcGitViewer({ dir }));
    if (!result.ok) {
      notify.error("Failed to load GitHub viewer", result.error);
      inFlight = undefined;
      return undefined;
    }
    if (!result.value.ok) {
      notify.error(
        ghErrorMessage(result.value.errorKind, "Failed to load GitHub viewer"),
        result.value.errorDetail || undefined,
      );
      // 失敗時は cached を書き込まない (次回呼び出しで retry 可能)。
      inFlight = undefined;
      return undefined;
    }
    cached = result.value.login;
    inFlight = undefined;
    return cached;
  })();
  return inFlight;
}
