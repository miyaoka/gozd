<doc lang="md">
1 セッション (main または subagent 1 つ) の transcript ペイン。左目次 + 右チャット本文 +
下部 footer を 1 つに閉じる。`SessionLogDialog` が main と subagent を横並びで同時に出すため、
scroll-spy (`IntersectionObserver`) や目次の現在地ハイライトは **このコンポーネントの
インスタンスごとに独立** する。複数ペインを並べても observer が干渉しないのはこの分離による。

## レイアウト

左目次 (user / assistant のみ、見出しは時刻) + 右トランスクリプト本文の 2 カラム、下に
footer。目次クリックで該当イベントへスクロールし、`IntersectionObserver` で現在地を
ハイライトする。

右トランスクリプトは LINE のトーク画面に倣ったチャット表示。user (貼り付け画像含む) を
自分として右寄せ、assistant を左寄せの吹き出しにする。話者は左右寄せ + 緑/zinc の塗り分けで
識別できるため、アバターや話者アイコンは置かない。thinking / tool は LINE に対応物が無いため、
中央寄せの控えめなシステム行に畳む。

## 設計判断

- 吹き出し (user / assistant / image) は常時表示、システム行 (thinking / tool) のみ
  `<details>` のネイティブ開閉に委ね、Vue 側に per-event の ref を持たない
- scroll-spy は `IntersectionObserver`。純 CSS の scroll marker / `:target-current` は
  WebKit (Safari 26 / macOS 26) 未対応のため使えない。チャット行の最外要素に `data-ev`
  を残し、user / assistant 行を index で観測する
- `parsed` が差し替わる (別 subagent を選び直す等) たびに observer を貼り直す
- `sessionKey` は v-for の :key 先頭に混ぜ、別セッションへ切り替わった際に `<details>` を
  確実に作り直す (index 単独だと Vue が要素を再利用し open 状態が別 kind に誤継承される)
</doc>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { MarkdownBody } from "../preview";
import {
  formatSessionTime,
  nearestEventIndexByTs,
  type ParsedSessionLog,
  type SubagentLink,
  type TranscriptEvent,
} from "./sessionLog";
import SessionLogSubagentButton from "./SessionLogSubagentButton.vue";
import SessionLogTimestamp from "./SessionLogTimestamp.vue";
import SessionLogToolArg from "./SessionLogToolArg.vue";

const props = defineProps<{
  parsed: ParsedSessionLog;
  // 別セッションへ切り替わった際に <details> を作り直すための :key prefix。
  sessionKey: string;
  // main ペイン専用。tool event の toolUseId → 紐づく subagent。
  // 該当があれば summary に subagent を開くボタンを出す。
  subagentLinks?: Map<string, SubagentLink>;
  // subagent ペイン専用。指定 ts に最も近いイベントへ 1 ショットでスクロールする。
  // nonce は同一 ts の再クリックでも watch を発火させるための単調増加カウンタ。
  scrollTo?: { ts: string; nonce: number };
}>();

const emit = defineEmits<{
  (e: "open-subagent", payload: { agentId: string; ts: string }): void;
}>();

const notify = useNotificationStore();

function subagentLinkFor(toolUseId: string): SubagentLink | undefined {
  return props.subagentLinks?.get(toolUseId);
}

type EventKind = TranscriptEvent["kind"];

// role ごとの色 (SSOT)。目次のドットと吹き出しが同一 role には必ず同一 hue を使う。
// LINE に倣い自分 (user) を緑、相手 (assistant) を無彩 zinc にし、アクセント hue は緑 1 つに絞る。
// 目次の時刻テキストは role 非依存の neutral にし (色の責務をドットに閉じる)、緑の高視感度が
// 時刻ラベルの可読性を role で揺らさないようにする。
const ROLE_COLOR: Record<"user" | "assistant", string> = {
  user: "text-green-400",
  assistant: "text-zinc-400",
};

// thinking と tool はデフォルト閉じる (思考過程とツール詳細はノイズになりやすく、
// user / assistant の会話を読みやすくするため)。中央システム行として畳んだ状態で見せる。
const DEFAULT_COLLAPSED = new Set<EventKind>(["thinking", "tool"]);
function defaultOpen(kind: EventKind): boolean {
  return !DEFAULT_COLLAPSED.has(kind);
}

// tool input の整形済み JSON (event index → 文字列)。scroll-spy の activeIndex 更新で
// コンポーネント全体が再描画されるため、テンプレートで毎回 JSON.stringify すると大きな入力
// ほどスクロールが重くなる。parsed 切替時にだけ計算する computed に逃がし、テンプレートは
// Map 参照に留めて再描画ホットパスから整形コストを外す。
const formattedInputs = computed<Map<number, string>>(() => {
  const map = new Map<number, string>();
  props.parsed.events.forEach((ev, index) => {
    if (ev.kind === "tool") map.set(index, JSON.stringify(ev.input, null, 2));
  });
  return map;
});

/**
 * 目次用の 1 行 timestamp。日付があれば時刻の前に連結する (吹き出し脇は
 * `SessionLogTimestamp` が同じ `formatSessionTime` を 2 行で描画する)。
 */
function formatTime(ts: string): string {
  const { date, time } = formatSessionTime(ts);
  return date === "" ? time : `${date} ${time}`;
}

const footerSummary = computed<string>(() => {
  const log = props.parsed;
  const parts = [`${log.events.length} events`, `${log.totalLines} lines`];
  if (log.skipped > 0) parts.push(`${log.skipped} non-conversation hidden`);
  if (log.emptyThinking > 0) parts.push(`${log.emptyThinking} empty thinking hidden`);
  if (log.malformed > 0) parts.push(`${log.malformed} malformed`);
  return parts.join(" · ");
});

// 右ペイン本文のスクロールコンテナ。目次クリック時に該当イベント要素を引いてスクロールする。
const contentRef = ref<HTMLElement | undefined>(undefined);

// 左の目次は user / assistant に絞り、見出しは時刻のみ。index は本文側イベントとの対応キー。
interface TocEntry {
  index: number;
  time: string;
  kind: "user" | "assistant";
}
const tocEntries = computed<TocEntry[]>(() => {
  const entries: TocEntry[] = [];
  props.parsed.events.forEach((ev, index) => {
    if (ev.kind === "user" || ev.kind === "assistant") {
      entries.push({ index, time: formatTime(ev.ts), kind: ev.kind });
    }
  });
  return entries;
});

function scrollToEvent(index: number) {
  const el = contentRef.value?.querySelector(`[data-ev="${index}"]`);
  if (el instanceof HTMLElement) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- 時刻ジャンプ (subagent ペイン) ---
//
// main の Agent / SendMessage を ts 付きでクリックされたら、この subagent ログの中で
// その ts に最も近いイベントへスクロールする (`nearestEventIndexByTs`)。resume の注入 user
// メッセージは SendMessage 発火の数十ms後に subagent ログへ書かれるため最近傍 ts で当たる。
//
// assistant の markdown は MarkdownBody が async (marked.parse) で描画するため、ジャンプ先の
// 上方に markdown があると高さが後から確定しスクロール位置がずれる。そこで markdown を含む
// ペインのみ、rendered の coalesce tick で 1 度だけ補正する。補正待ちを pendingScrollTs に
// 保持する。markdown を含まないペインは初回スクロールで高さが確定済みなので補正不要 ―
// その場合 pendingScrollTs を宙に残さないよう初回適用直後にクリアする (rendered が永遠に
// 発火しないため、補正経路だけに掃除を任せられない)。
let pendingScrollTs: string | undefined;
const hasMarkdownEvent = (): boolean => props.parsed.events.some((ev) => ev.kind === "assistant");

function applyScroll(ts: string) {
  const index = nearestEventIndexByTs(props.parsed.events, ts);
  if (index !== undefined) scrollToEvent(index);
}

// scrollTo (または初回 mount の既存 target) を最近傍イベントへ寄せる共通処理。
async function scrollToTarget(ts: string) {
  pendingScrollTs = ts;
  await nextTick();
  applyScroll(ts);
  // markdown が無ければ rendered 補正が来ないため、ここで掃除して invariant を閉じる。
  if (!hasMarkdownEvent()) pendingScrollTs = undefined;
}

watch(
  () => props.scrollTo,
  (next) => {
    if (next === undefined) return;
    void scrollToTarget(next.ts);
  },
);

// assistant markdown 内リンクのポリシー。
// session log dialog は MarkdownPreview と違い worktree 相対解決の文脈を持たないため、
// 外部 http(s) URL のみ素通しし (ExternalLinkNavigationDecider が外部ブラウザで開く)、
// それ以外 (相対パス / ルート絶対パス / protocol-relative / fragment / 他 scheme) はすべて
// 無効化する。放置すると gozd-app:// 基準で解決され WebView の main frame 置換リスクがある。
// 相対解決を意図的に行わない設計なので resolveMarkdownLink は再利用しない (ポリシーが異なる)。
const EXTERNAL_HTTP_RE = /^https?:\/\//i;
function onAssistantLinkClick(e: MouseEvent) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.closest("a");
  if (anchor === null) return;
  const href = anchor.getAttribute("href");
  if (href === null) return;
  // 外部 http(s) は decider に委ねて素通し。
  if (EXTERNAL_HTTP_RE.test(href)) return;
  // それ以外は WebView 内遷移を止める。空 href はクリック対象が無いだけなので無通知。
  e.preventDefault();
  if (href !== "") {
    notify.info("Only external http(s) links are navigable in the session log viewer", { href });
  }
}

// --- scroll-spy (現在地ハイライト) ---
//
// 純 CSS の scroll marker / :target-current は WebKit 未対応 (2026-05 時点) のため、
// IntersectionObserver で「右ペイン上部バンドに入っている user/assistant イベント」を
// 検出して目次をハイライトする。bottom margin -65% で active 判定をコンテナ上部 35% に絞る。
const activeIndex = ref<number | undefined>(undefined);
let observer: IntersectionObserver | undefined;
// IntersectionObserver は変化のあった target だけを callback に渡すため、可視 index の
// 累積集合を closure に保持し、毎回そこから topmost を選ぶ。
const visibleIndices = new Set<number>();

function teardownObserver() {
  observer?.disconnect();
  observer = undefined;
  visibleIndices.clear();
  // 保留中の再 setup rAF も破棄し、observer と rAF のライフサイクルを揃える
  // (unmount / parsed 切替後に宙に浮いた rAF が setupObserver を呼ぶのを防ぐ)。
  if (resetupRaf !== undefined) {
    cancelAnimationFrame(resetupRaf);
    resetupRaf = undefined;
  }
  resetupQueued = false;
}

function setupObserver() {
  teardownObserver();
  const root = contentRef.value;
  if (root === undefined) return;

  // 目次に出る user/assistant イベントだけを監視対象にする。
  const tocIndices = new Set(tocEntries.value.map((entry) => entry.index));

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.ev);
        if (Number.isNaN(idx)) continue;
        if (entry.isIntersecting) visibleIndices.add(idx);
        else visibleIndices.delete(idx);
      }
      // 可視のうち最上 (= 最小 index) を現在地にする。バンド外 (どれも非可視) のときは
      // 直前の active を保ち、スクロール中のちらつきを避ける。
      if (visibleIndices.size > 0) {
        activeIndex.value = Math.min(...visibleIndices);
      }
    },
    { root, rootMargin: "0px 0px -65% 0px", threshold: 0 },
  );

  for (const el of root.querySelectorAll<HTMLElement>("[data-ev]")) {
    const idx = Number(el.dataset.ev);
    if (tocIndices.has(idx)) observer.observe(el);
  }
}

// parsed が差し替わる (別 subagent を選び直す等) たびに observer を貼り直す。
// contentRef は v-if でマウントされるので nextTick で DOM 反映を待つ。immediate で
// 初回マウント時の貼り付けも兼ねる。
watch(
  () => props.parsed,
  async () => {
    activeIndex.value = undefined;
    await nextTick();
    setupObserver();
  },
);

onMounted(() => {
  setupObserver();
  // 別 subagent へ切替時は :key でこのコンポーネントが作り直されるため、初回 mount 時に
  // scrollTo が既に設定されている。watch は immediate でないのでここで初回ジャンプを担う。
  const target = props.scrollTo;
  if (target !== undefined) void scrollToTarget(target.ts);
});

// assistant の markdown は MarkdownBody が async (marked.parse) で描画するため、
// 上の nextTick 時点では高さがほぼ 0。描画完了 (rendered) 後に observe を貼り直さないと
// IntersectionObserver の判定が描画前レイアウトでズレる。複数ブロックの rendered が
// 連続発火するので rAF で 1 回に coalesce する。
let resetupQueued = false;
let resetupRaf: number | undefined;
function onMarkdownRendered() {
  if (resetupQueued) return;
  resetupQueued = true;
  resetupRaf = requestAnimationFrame(() => {
    resetupQueued = false;
    resetupRaf = undefined;
    setupObserver();
    // markdown 描画で上方の高さが確定した後、保留中の時刻ジャンプを 1 度だけ補正する。
    // 補正後はクリアし、以降の手動スクロールを上書きしない。
    if (pendingScrollTs !== undefined) {
      const ts = pendingScrollTs;
      pendingScrollTs = undefined;
      applyScroll(ts);
    }
  });
}

onBeforeUnmount(teardownObserver);
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <!-- 本文: 空ログメッセージ or [左 目次 + 右 トランスクリプト] -->
    <p v-if="parsed.events.length === 0" class="px-4 py-3 text-sm text-zinc-400">
      Session log has no conversation events.
    </p>

    <div v-else class="flex min-h-0 flex-1">
      <!-- 左: 目次 (user / assistant のみ、見出しは時刻) -->
      <nav class="w-32 shrink-0 overflow-y-auto border-r border-zinc-800 py-2">
        <button
          v-for="entry in tocEntries"
          :key="entry.index"
          type="button"
          class="flex w-full items-center gap-1.5 border-l-2 px-3 py-1 text-left text-[11px] text-zinc-300 tabular-nums transition-colors hover:bg-white/5"
          :class="
            activeIndex === entry.index
              ? 'border-zinc-400 bg-white/10 font-semibold'
              : 'border-transparent opacity-70'
          "
          @click="scrollToEvent(entry.index)"
        >
          <!-- role 識別はこのドット 1 点に閉じる (テキストは neutral) -->
          <span class="size-1.5 shrink-0 rounded-full bg-current" :class="ROLE_COLOR[entry.kind]" />
          <span class="truncate">{{ entry.time || "—" }}</span>
        </button>
      </nav>

      <!-- 右: トランスクリプト本文 (LINE 風チャット) -->
      <div ref="contentRef" class="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <template v-for="(ev, i) in parsed.events" :key="`${sessionKey}:${i}`">
          <!-- thinking / tool: 中央寄せの控えめなシステム行 (デフォルト閉じ) -->
          <details
            v-if="ev.kind === 'thinking' || ev.kind === 'tool'"
            :data-ev="i"
            :open="defaultOpen(ev.kind)"
            class="scroll-mt-2"
          >
            <!-- 控えめなシステム行。会話 (塗り吹き出し) と「塗り面か否か」で峻別するため、
                 休止状態は塗り無しの中央寄せ素テキストにする (LINE のシステム通知に倣う)。
                 hover の塗りは操作 feedback のみで、休止状態の形は吹き出しと衝突させない。
                 アイコン / hue 装飾は持たず、主従は weight (tool 名 = primary)、状態色は
                 error の red のみ。時刻は会話吹き出し側で足りるため出さない。 -->
            <summary
              class="mx-auto flex w-fit max-w-[70%] cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-zinc-500 select-none hover:bg-white/5 [&::-webkit-details-marker]:hidden"
            >
              <span v-if="ev.kind === 'thinking'">thinking</span>
              <template v-else>
                <!-- tool 名 = primary (weight)。error は引数 truncate に押し出されないよう名直後。 -->
                <span class="shrink-0 font-mono font-medium text-zinc-300">{{ ev.name }}</span>
                <span
                  v-if="ev.result?.isError"
                  class="shrink-0 rounded-sm bg-red-500/20 px-1 whitespace-nowrap text-red-300"
                  >error</span
                >
                <SessionLogToolArg :input="ev.input" />
                <!-- Agent / SendMessage が subagent に結べるなら、開くボタンを出す。 -->
                <SessionLogSubagentButton
                  :link="subagentLinkFor(ev.toolUseId)"
                  :ts="ev.ts"
                  @open="emit('open-subagent', $event)"
                />
              </template>
            </summary>

            <!-- thinking 平文 -->
            <div
              v-if="ev.kind === 'thinking'"
              class="mx-auto mt-1 max-w-[85%] rounded-md bg-white/5 px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-zinc-400"
            >
              {{ ev.text }}
            </div>
            <!-- tool: input 全体 + 実行結果 -->
            <div v-else class="mx-auto mt-1 max-w-[85%] space-y-2 rounded-md bg-white/5 px-3 py-2">
              <pre
                class="overflow-x-auto rounded-sm bg-zinc-800 p-2 text-xs text-zinc-300"
              ><code>{{ formattedInputs.get(i) }}</code></pre>
              <div v-if="ev.result">
                <p class="mb-1 text-[10px] text-zinc-500">
                  {{ ev.result.isError ? "Error output" : "Output" }}
                </p>
                <pre
                  class="max-h-72 overflow-auto rounded-sm bg-zinc-800 p-2 text-xs"
                  :class="ev.result.isError ? 'text-red-300' : 'text-zinc-300'"
                ><code>{{ ev.result.text }}</code></pre>
              </div>
              <p v-else class="text-[10px] text-zinc-500 italic">(no result recorded)</p>
            </div>
          </details>

          <!-- user / image (自分, 右寄せ) と assistant (相手, 左寄せ) の吹き出し。
               話者は左右寄せ + 緑/zinc の塗り分けで識別でき、アバターは置かない。 -->
          <div
            v-else
            :data-ev="i"
            class="flex scroll-mt-2 items-end gap-1.5"
            :class="ev.kind === 'assistant' ? 'flex-row' : 'flex-row-reverse'"
          >
            <!-- assistant: markdown 吹き出し (相手色 zinc-800)。
                 MarkdownBody はコードブロック背景を暗地前提の zinc-800 で固定するため、
                 塗りを被せると地より暗いブロックが浮く明度反転になる。`--md-code-bg` で地より
                 一段明るい zinc-700 を渡し、preview と同じ「地 < code」の明度順を保つ。 -->
            <div
              v-if="ev.kind === 'assistant'"
              class="min-w-0 rounded-2xl rounded-tl-sm bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 [--md-code-bg:var(--color-zinc-700)]"
            >
              <MarkdownBody
                :content="ev.text"
                @link-click="onAssistantLinkClick"
                @rendered="onMarkdownRendered"
              />
            </div>

            <!-- user: 素テキスト吹き出し (自分色)。LINE の自分発話に倣い緑塗り。
                 緑は唯一のアクセントとし、相手 (無彩) と hue で 1 つだけ差をつける。暗 UI
                 (zinc-900 地) で面が主張しすぎないよう緑は一段暗い green-800 に抑える。 -->
            <div
              v-else-if="ev.kind === 'user'"
              class="min-w-0 rounded-2xl rounded-tr-sm bg-green-800 px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-green-50"
            >
              {{ ev.text }}
            </div>

            <!-- image: 吹き出し背景なしで素の角丸画像。source 不明なら placeholder。 -->
            <img
              v-else-if="ev.kind === 'image' && ev.src"
              :src="ev.src"
              alt="session log image"
              class="max-h-96 max-w-[75%] rounded-2xl border border-zinc-700"
            />
            <span
              v-else-if="ev.kind === 'image'"
              class="max-w-[75%] rounded-2xl bg-zinc-800 px-3 py-2 text-sm text-zinc-500 italic"
              >(image content unavailable)</span
            >

            <!-- 時刻は吹き出しの下端脇に小さく。別日は日付 / 時刻を 2 行に分け、
                 隣接する吹き出し側 (assistant=左 / user=右) に寄せる。 -->
            <SessionLogTimestamp :ts="ev.ts" :align="ev.kind === 'assistant' ? 'left' : 'right'" />
          </div>
        </template>
      </div>
    </div>

    <!-- フッタ (このペインの統計) -->
    <div class="shrink-0 border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-500 tabular-nums">
      {{ footerSummary }}
    </div>
  </div>
</template>
