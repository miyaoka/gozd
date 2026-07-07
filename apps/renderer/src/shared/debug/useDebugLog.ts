import { computed, ref } from "vue";

/** 観測イベント 1 件。`channel` で発生源、`label` で種別、`repo` で対象 repo / worktree、`detail` で補足。 */
interface DebugEvent {
  id: number;
  /** epoch ms (`Date.now()`) */
  t: number;
  channel: string;
  label: string;
  /** 対象 repo / worktree 名。どの repo を処理したか一目で分かるようにする。無関係な event (focus 等) は空文字。 */
  repo: string;
  detail: string;
}

/** main プロセス発の観測イベントを renderer の logEvent に載せる push payload。
 * main 側（utilityProcess 隔離した watcher の crash/respawn 等）は renderer の
 * ring buffer に直接触れないため、`debugLog` push でこの形を送り bridge が logEvent に渡す。 */
export interface DebugLogPayload {
  channel: string;
  label: string;
  repo: string;
  detail: string;
}

/** ring buffer 上限。超過分は古い順に捨てる。 */
const MAX_EVENTS = 500;

// module singleton。全 feature が同一 buffer に吐き、EventLogPanel が同一 ref を購読する。
const events = ref<DebugEvent[]>([]);
let nextId = 0;

/**
 * 観測イベントを積む。**dev / prod 両方で常時有効**にするのが意図で、DEV ゲートを掛けない
 * (prod でこそ「どのくらい実行されているか」を観測したいため)。発火頻度が高い経路から
 * 呼ばれても O(1) push + 上限超過時だけ trim で軽量に保つ。
 */
export function logEvent(channel: string, label: string, repo = "", detail = ""): void {
  events.value.push({ id: nextId++, t: Date.now(), channel, label, repo, detail });
  const overflow = events.value.length - MAX_EVENTS;
  if (overflow > 0) events.value.splice(0, overflow);
}

/** イベントログの読み取り面。EventLogPanel が購読する。 */
export function useDebugLog() {
  /** `channel:label` ごとの累計回数を key 昇順で。「どのくらい実行されているか」の要約。 */
  const counts = computed<[string, number][]>(() => {
    const map = new Map<string, number>();
    for (const e of events.value) {
      const key = `${e.channel}:${e.label}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  function clear(): void {
    events.value = [];
  }

  return { events, counts, clear };
}
