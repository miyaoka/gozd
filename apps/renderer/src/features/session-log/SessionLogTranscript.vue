<doc lang="md">
1 セッション (main または subagent 1 つ) の transcript ペイン。チャット本文 + 下部 footer を
1 つに閉じる。現在地 (topmost 可視イベントの ts) は `IntersectionObserver` で検出し
`current-ts` で親へ通知する。親はそれを横断タイムライン (`SessionLogTimeline`) の playhead に
使う。observer は **このコンポーネントのインスタンスごとに独立** するため、main と subagent を
横並びにしても干渉しない。

## レイアウト

上部にヘッダ (どの agent のログかを示す agent 名 + 使用 model バッジ + Claude Code バージョン + dim な id) を置き、トランスクリプト本文
1 カラム + 下に footer。本文は LINE ダークモードに倣ったチャット表示で、user (貼り付け
画像含む) を自分として右寄せ、assistant を左寄せの吹き出しにする。配色は chat-\* semantic
token を介して TerminalSessionPreview と SSOT 共有する (user=`bg-chat-outgoing` + 黒文字 /
assistant=`bg-chat-incoming` + 白文字 / inline code=`var(--color-chat-code)` の紫)。話者は
左右寄せ + chat-outgoing/chat-incoming の塗り分けで識別できるため、アバターや話者アイコン
は置かない。thinking / tool は LINE に対応物が無いため、中央寄せの控えめなシステム行に
畳む。現在地のナビゲーションはペイン内に持たず、親の横断タイムラインに集約する
(`scrollTo` で時刻位置へジャンプを受ける)。

## 設計判断

- 吹き出し (user / assistant / image) は常時表示、システム行 (thinking / tool) のみ
  `<details>` のネイティブ開閉に委ね、Vue 側に per-event の ref を持たない
- rewind 分岐は `branch` イベントとして中央寄せのセレクタ行で出す。番号は古い順 (最新が最大)、
  選択中の枝をハイライトし、他をクリックで `select-branch` を emit して親に枝の切り替えを委ねる
- AskUserQuestion (`ask` イベント) は「assistant の質問 + 選択肢 + user の回答」を 1 つの
  会話ブロックに畳む。質問は assistant 吹き出し (左)、選択肢を chip 列で並べ (選択された
  option のみ success 色でハイライト)、回答を user 吹き出し (右) に出す。複数 question を
  持つケースは Q→options→A のセットを縦に並べる。回答未充填 (resume 中断 / `toolUseResult.answers`
  欠落) は user 吹き出しの代わりに dim な「(no response)」を出す。scroll-spy の観測対象に含める
  (user / assistant と同じ会話扱い)
- teammate (`teammate` イベント = 他の Claude セッションからの発話) は user/assistant の左右
  吹き出しと別レーンで、`teammate · {summary}` の見出し + 本文 markdown を持つ枠で出す。peer
  からの inbound なので会話扱い (scroll-spy の観測対象に含める)
- scroll-spy は `IntersectionObserver`。純 CSS の scroll marker / `:target-current` は
  WebKit (Safari 26 / macOS 26) 未対応のため使えない。チャット行の最外要素に `data-ev`
  を残し、user / assistant 行を index で観測して topmost の ts を `current-ts` に出す
- `parsed` が差し替わる (別 subagent を選び直す等) たびに observer を貼り直す
- `sessionKey` は v-for の :key 先頭に混ぜ、別セッションへ切り替わった際に `<details>` を
  確実に作り直す (index 単独だと Vue が要素を再利用し open 状態が別 kind に誤継承される)

## ボトム追従 (ライブ更新)

`parsed` がライブ更新で差し替わるたび、更新前にボトム付近 (`BOTTOM_THRESHOLD` 以内) にいた
場合だけボトムへ追従する (ターミナル / ログビューア標準の sticky bottom)。スクロールバック中は
追従せず、本文下部に sticky 配置の「New updates」ボタンを出してクリックで最新へ飛ばす。初回
mount もボトム表示。markdown は async 描画で高さが後から確定するため、追従要求は
`pendingBottomScroll` に積み `onMarkdownRendered` で再適用する。時刻ジャンプ
(`scrollTo`) が同時に立った場合は明示操作を優先しボトム追従を捨てる。ボタンは sticky 配置で
スクロールポート下端に固定し、flex のサイズ計算に干渉させない (ラッパー追加による横幅膨張を回避)。
</doc>

<script setup lang="ts">
import {
  type ImageSource,
  type ParsedSessionLog,
  type TranscriptEvent,
} from "@gozd/claude-session-log";
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { MarkdownBody } from "../preview";
import SessionLogSubagentButton from "./SessionLogSubagentButton.vue";
import SessionLogTimestamp from "./SessionLogTimestamp.vue";
import SessionLogToolArg from "./SessionLogToolArg.vue";
import {
  type BranchSelectPayload,
  formatModelLabel,
  nearestEventIndexByTs,
  type SubagentLinkResult,
} from "./sessionLogView";
import IconLucideArrowDown from "~icons/lucide/arrow-down";
import IconLucideFileJson from "~icons/lucide/file-json";
import IconLucideGitBranch from "~icons/lucide/git-branch";
import IconLucideUsers from "~icons/lucide/users";

const props = defineProps<{
  parsed: ParsedSessionLog;
  // ペイン上部ヘッダの agent 名 (main は "Main"、subagent は表示ラベル)。
  title: string;
  // ヘッダの dim な副題 (main は session_id、subagent は agent_id)。
  subtitle?: string;
  // 別セッションへ切り替わった際に <details> を作り直すための :key prefix。
  sessionKey: string;
  // main ペイン専用。tool event の toolUseId → 紐づく subagent の解決結果。
  // Agent/SendMessage/Workflow の呼び出しには resolved/unresolved いずれかの entry があり、
  // それ以外の tool (Bash 等) には entry 自体が無い (buildSubagentLinks が判定済み)。
  subagentLinks?: Map<string, SubagentLinkResult>;
  // 指定 ts に最も近いイベントへ 1 ショットでスクロールする (横断タイムラインの seek 起点。
  // main / subagent どちらのペインも受ける)。nonce は同一 ts の再クリックでも watch を
  // 発火させるための単調増加カウンタ。
  scrollTo?: { ts: string; nonce: number };
  // このペインの生 jsonl の絶対パス。指定すると「preview で生ログを開く」ボタンを出す
  // (dialog 経路のみ。terminal preview は preview pane と同居しないため渡さない)。
  filePath?: string;
}>();

const emit = defineEmits<{
  (e: "open-subagent", payload: { agentId: string; ts: string }): void;
  // topmost に見えている会話イベントの ts。親 (SessionLogDialog) が横断タイムラインの
  // playhead 位置に使う。スクロールに追従して発火する。
  (e: "current-ts", ts: string): void;
  // rewind 分岐セレクタのクリック。親が payload.sessionKey のタブの branch 選択を更新して
  // transcript を該当バージョンへ再構築する。ts は選択枝先頭の時刻で、切替後にその分岐点へ寄せるのに使う。
  (e: "select-branch", payload: BranchSelectPayload): void;
  // ヘッダの「生ログを開く」ボタン。親 (dialog) が dialog を閉じて preview に filePath を出す。
  (e: "open-file", path: string): void;
}>();

const notify = useNotificationStore();

function subagentLinkFor(toolUseId: string): SubagentLinkResult | undefined {
  return props.subagentLinks?.get(toolUseId);
}

type EventKind = TranscriptEvent["kind"];

// thinking と tool はデフォルト閉じる (思考過程とツール詳細はノイズになりやすく、
// user / assistant の会話を読みやすくするため)。中央システム行として畳んだ状態で見せる。
const DEFAULT_COLLAPSED = new Set<EventKind>(["thinking", "tool"]);
function defaultOpen(kind: EventKind): boolean {
  return !DEFAULT_COLLAPSED.has(kind);
}

// rewind 分岐セレクタの選択肢クリック。vue-tsc 3.3.6 以降、複数行のインラインハンドラは
// 関数スコープに包まれ v-if による ev の narrowing がハンドラ式内へ届かないため、
// union のまま受けて script 側で絞り直す。
function selectBranchOption(ev: TranscriptEvent, opt: { childUuid: string; ts: string }) {
  if (ev.kind !== "branch") return;
  emit("select-branch", {
    sessionKey: props.sessionKey,
    branchKey: ev.branchKey,
    childUuid: opt.childUuid,
    ts: opt.ts,
  });
}

// tool input の整形済み JSON (event index → 文字列)。テンプレートで毎回 JSON.stringify すると
// 再描画 (ライブ更新の parsed 差し替えや details の開閉) のたびに大きな入力ほど重くなる。
// parsed 切替時にだけ計算する computed に逃がし、テンプレートは Map 参照に留めて整形コストを外す。
const formattedInputs = computed<Map<number, string>>(() => {
  const map = new Map<number, string>();
  props.parsed.events.forEach((ev, index) => {
    if (ev.kind === "tool") map.set(index, JSON.stringify(ev.input, null, 2));
  });
  return map;
});

// この agent が実際に使った model の表示名。複数混在 (/model 切り替え) は中黒で連ねる。
// effort は JSONL に残らずセッションファイル自己完結の対象外のため model のみ出す。
const modelLabel = computed<string>(() => props.parsed.models.map(formatModelLabel).join(" · "));

// このセッションを書いた Claude Code のバージョン。auto-update でセッション途中に上がると複数
// 混在しうるため中黒で連ねる。session log の挙動差 (中継の記録形式変更等) はバージョンに紐づくため、
// どのバージョンが書いたログかをペインヘッダで可視化する。
const versionLabel = computed<string>(() =>
  props.parsed.versions.length === 0 ? "" : `v${props.parsed.versions.join(" · ")}`,
);

// 検証済み ImageSource を HTML の data: URL にする。parse は表示ターゲット非依存の
// {mediaType,base64} までを載せ、ブラウザ固有の URL 形式組み立ては view の責務。
function imageDataUrl(source: ImageSource): string {
  return `data:${source.mediaType};base64,${source.base64}`;
}

// teammate (peer セッション) 発話の見出し。summary 優先、無ければ from。どちらも空なら "teammate"。
function teammateHeader(ev: Extract<TranscriptEvent, { kind: "teammate" }>): string {
  const label = ev.summary !== "" ? ev.summary : ev.from;
  return label !== "" ? `teammate · ${label}` : "teammate";
}

const footerSummary = computed<string>(() => {
  const log = props.parsed;
  const parts = [`${log.events.length} events`, `${log.totalLines} lines`];
  if (log.skipped > 0) parts.push(`${log.skipped} non-conversation hidden`);
  if (log.emptyThinking > 0) parts.push(`${log.emptyThinking} empty thinking hidden`);
  if (log.malformed > 0) parts.push(`${log.malformed} malformed`);
  return parts.join(" · ");
});

// 本文のスクロールコンテナ。時刻ジャンプ時に該当イベント要素を引いてスクロールする。
const contentRef = ref<HTMLElement | undefined>(undefined);

// playhead 用に観測する会話イベント (user / assistant / ask) の index 集合。scroll-spy は
// この集合の topmost 可視 index を現在地とみなし、その ts を親へ emit する。ask は
// 「assistant の質問 + user の回答」を 1 ブロックに畳んだ会話イベントなので含める。
const observableIndices = computed<Set<number>>(() => {
  const set = new Set<number>();
  props.parsed.events.forEach((ev, index) => {
    if (
      ev.kind === "user" ||
      ev.kind === "assistant" ||
      ev.kind === "ask" ||
      ev.kind === "teammate"
    )
      set.add(index);
  });
  return set;
});

// 即時スクロール (behavior: "auto")。scrub ドラッグや main→sub 同期は pointermove / scroll の
// 高頻度で連続発火するため、smooth だと前のアニメーションが中断され続けてカクつく。即時にして
// カーソル / スクロールへ crisp に追従させる (呼び出しは scrollTo 駆動のジャンプのみ)。
function scrollToEvent(index: number) {
  const el = contentRef.value?.querySelector(`[data-ev="${index}"]`);
  if (el instanceof HTMLElement) el.scrollIntoView({ behavior: "auto", block: "start" });
}

// --- プログラム的スクロールの抑制 (横断タイムラインの playhead を「ユーザースクロール時だけ」動かす) ---
//
// playhead は「ユーザーが本文をスクロールしたらその時刻へ移動」する一方、シーク (scrollTo) や
// ボトム追従などプログラム的スクロールでは動かしたくない (= シークで置いた位置を保つ)。両者は
// scroll イベントでは区別できないため、プログラム的スクロールの直前に programmaticScroll を立て、
// その間は current-ts を emit しない。解除はタイマーでなくユーザー入力 (wheel / pointerdown /
// keydown / touchstart) で行う (スムーススクロールの所要時間に依存しない)。
//
// 初期値は true。初回 mount のボトムスクロール / 初回 scrollTo は programmatic だが、その確定
// (nextTick 後) より IntersectionObserver の初回コールバックが先に走りうる。false 始まりだと
// その隙に「ユーザー無操作の current-ts」を emit してしまうため、ユーザー入力があるまで抑制側に倒す。
let programmaticScroll = true;

// --- ボトム追従 (ライブ更新) ---
//
// セッション進行中はログがライブ更新される (`SessionLogDialog` の fsChange refresh で
// `parsed` が差し替わる)。ターミナル / ログビューア標準の「sticky bottom」に倣い、ユーザーが
// ボトム付近にいる間だけ更新でボトムへ追従し、スクロールバックして読んでいる最中は追従しない。
// 追従が外れている状態で更新が来たら本文下部に「New updates」ボタンを出し、クリックで最新へ飛ぶ。
//
// markdown は MarkdownBody が async で描画するため、`parsed` 差し替え直後は本文高さが未確定。
// 追従要求は `pendingBottomScroll` に積み、描画完了 (`onMarkdownRendered`) 後に再適用する。
const BOTTOM_THRESHOLD = 80; // この px 以内をボトム扱いにする (追従判定の許容幅)。
const showNewUpdates = ref(false);
let pendingBottomScroll = false;

function computeAtBottom(): boolean {
  const el = contentRef.value;
  if (el === undefined) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
}

function scrollToBottom() {
  const el = contentRef.value;
  if (el === undefined) return;
  programmaticScroll = true;
  el.scrollTop = el.scrollHeight;
  showNewUpdates.value = false;
}

// ユーザー操作スクロール (wheel / scrollbar drag / キー / タッチ) は programmaticScroll を解除し、
// 以降の observer 検出を playhead へ反映させる。scrollbar drag は pointerdown で拾う。
useEventListener(contentRef, ["wheel", "pointerdown", "keydown", "touchstart"], () => {
  programmaticScroll = false;
});

// スクロールで追従状態を更新する。ボトムへ戻ったら通知ボタンを消し、ユーザーが上方向へ
// スクロールしたら保留中の追従要求 (pendingBottomScroll) を捨てる。
//
// 打ち切りを computeAtBottom() ではなく「scrollTop が減ったか」で判定するのが要点。scroll
// イベントは scrollTop 代入に対し非同期発火する (WebKit 仕様) ため、追従中に後続 markdown が
// 描画されて scrollHeight が伸びた後に programmatic scrollToBottom の遅延イベントが届くと、
// computeAtBottom() だけでは「底でない」と誤判定し、ユーザー無操作のまま追従を打ち切ってしまう
// (= 複数ブロック描画で最後まで追従できない元の症状の再発)。programmatic な追従は scrollTop を
// 増やす (or 据え置く) だけで減らさないので、「減った = ユーザーが上方向へスクロールした」を
// 打ち切り条件にすれば遅延イベントで誤クリアしない。位置の方向で見るため wheel / scrollbar /
// keyboard どの入力源でも効き、フラグのタイミング依存も無い (isTrusted は programmatic でも
// true なので使えない)。
let lastScrollTop = 0;
useEventListener(contentRef, "scroll", () => {
  const el = contentRef.value;
  if (el === undefined) return;
  const top = el.scrollTop;
  if (computeAtBottom()) {
    showNewUpdates.value = false;
  } else if (top < lastScrollTop) {
    pendingBottomScroll = false;
  }
  lastScrollTop = top;
});

// 「New updates」ボタン。最新へ飛び、以降の更新を追従状態に戻す。
function jumpToLatest() {
  pendingBottomScroll = true;
  scrollToBottom();
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

// 次の parsed watch で 1 度だけボトム追従を抑止するフラグ。明示スクロール (時刻ジャンプ /
// rewind 枝切替) は parsed を差し替えるが分岐点 / seek 位置を保ちたい。pendingScrollTs を
// 抑止判定に使うと markdown 補正用に残った値が後続のライブ refresh のボトム追従まで誤抑止する
// (rendered 不発火で残るケース)。抑止は scrollTo watch が立てて parsed watch が 1 回で消す
// 専用フラグに分離し、pendingScrollTs (補正用) の生存と切り離す。
let bottomFollowSkipOnce = false;
const hasMarkdownEvent = (): boolean =>
  props.parsed.events.some((ev) => ev.kind === "assistant" || ev.kind === "teammate");

function applyScroll(ts: string) {
  const index = nearestEventIndexByTs(props.parsed.events, ts);
  if (index !== undefined) {
    programmaticScroll = true;
    scrollToEvent(index);
  }
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
    // 同 tick で起きる parsed 差し替え (枝切替) のボトム追従を 1 回だけ抑止する。この watch は
    // parsed watch より先に登録されるため、同期でフラグを立てれば後続の parsed watch が見られる。
    bottomFollowSkipOnce = true;
    void scrollToTarget(next.ts);
  },
);

// assistant markdown 内リンクのポリシー。
// session log dialog は MarkdownPreview と違い worktree 相対解決の文脈を持たないため、
// 外部 http(s) URL のみ素通しし (main 側の navigation 防壁が外部ブラウザで開く)、
// それ以外 (相対パス / ルート絶対パス / protocol-relative / fragment / 他 scheme) はすべて
// 無効化する。放置すると renderer origin 基準で解決され main frame 置換リスクがある。
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

// --- scroll-spy (現在地 → 横断タイムラインの playhead) ---
//
// 純 CSS の scroll marker / :target-current は WebKit 未対応 (2026-05 時点) のため、
// IntersectionObserver で「本文上部バンドに入っている user/assistant イベント」を検出し、
// その topmost の ts を親へ emit する。親はそれを横断タイムラインの playhead 位置に使う。
// bottom margin -65% で現在地判定をコンテナ上部 35% に絞る。
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

  // user/assistant イベントだけを監視対象にする。
  const targetIndices = observableIndices.value;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.ev);
        if (Number.isNaN(idx)) continue;
        if (entry.isIntersecting) visibleIndices.add(idx);
        else visibleIndices.delete(idx);
      }
      // プログラム的スクロール (シーク / ボトム追従) では playhead を動かさない。ユーザー操作
      // スクロールでのみ現在地を通知する (区別は programmaticScroll フラグ)。
      if (programmaticScroll) return;
      // 可視のうち最上 (= 最小 index) を現在地とし、その ts を親へ通知する。バンド外
      // (どれも非可視) のときは何も emit せず、直前の playhead 位置を保つ。
      if (visibleIndices.size > 0) {
        const ts = props.parsed.events[Math.min(...visibleIndices)]?.ts;
        if (ts !== undefined && ts !== "") emit("current-ts", ts);
      }
    },
    { root, rootMargin: "0px 0px -65% 0px", threshold: 0 },
  );

  for (const el of root.querySelectorAll<HTMLElement>("[data-ev]")) {
    const idx = Number(el.dataset.ev);
    if (targetIndices.has(idx)) observer.observe(el);
  }
}

// parsed が差し替わる (別 subagent を選び直す等) たびに observer を貼り直す。
// contentRef は v-if でマウントされるので nextTick で DOM 反映を待つ。immediate で
// 初回マウント時の貼り付けも兼ねる。
watch(
  () => props.parsed,
  async () => {
    // flush 'pre' なので DOM patch 前。ここで読む scroll 位置は「更新前にボトムにいたか」。
    const wasAtBottom = computeAtBottom();
    await nextTick();
    setupObserver();
    // 明示スクロール (時刻ジャンプ / rewind 枝切替) 由来の parsed 差し替えならボトム追従しない。
    // 枝切替はこの watch を走らせるが、ライブ追記と違い分岐点 / seek 位置へ寄せたい。scrollTo
    // watch (この watch より先に登録) が同期で立てたフラグを 1 回で消費して回避する。
    if (bottomFollowSkipOnce) {
      bottomFollowSkipOnce = false;
      return;
    }
    // ボトムにいたら追従、離れていたら通知ボタンを出して位置を保つ。離れている間は
    // 保留中の追従要求もクリアし、後から markdown 描画が来てもボトムへ引き戻さない。
    if (wasAtBottom) {
      pendingBottomScroll = true;
      scrollToBottom();
    } else {
      pendingBottomScroll = false;
      showNewUpdates.value = true;
    }
  },
);

onMounted(() => {
  setupObserver();
  // 別 subagent へ切替時は :key でこのコンポーネントが作り直されるため、初回 mount 時に
  // scrollTo が既に設定されている。watch は immediate でないのでここで初回ジャンプを担う。
  const target = props.scrollTo;
  if (target !== undefined) {
    void scrollToTarget(target.ts);
    return;
  }
  // 初回は最新ログを見せるためボトムへ。markdown 描画後に onMarkdownRendered が再補正する。
  pendingBottomScroll = true;
  void nextTick().then(scrollToBottom);
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
    // markdown 描画で上方/下方の高さが確定した後、保留中のスクロールを 1 度だけ補正する。
    // 補正後はクリアし、以降の手動スクロールを上書きしない。時刻ジャンプ (明示操作) を
    // ボトム追従より優先し、両方立っていても ts ジャンプ側を採る。
    if (pendingScrollTs !== undefined) {
      const ts = pendingScrollTs;
      pendingScrollTs = undefined;
      pendingBottomScroll = false;
      applyScroll(ts);
    } else if (pendingBottomScroll) {
      // ここでは pendingBottomScroll をクリアしない: 1 回の更新で複数 markdown ブロックが
      // 追記されると各 rendered が時間差で個別 rAF を起こす。最初の rAF 時点では後続ブロックが
      // 未描画で scrollHeight が最終高に達していないため、保持して各 rendered ごとに底へ追従し
      // 続ける。離脱の検知は scroll listener が担い、ユーザーがボトムから離れた時点で
      // pendingBottomScroll を false にする。これで描画連鎖の途中で離脱しても引き戻さない。
      scrollToBottom();
    }
  });
}

onBeforeUnmount(teardownObserver);
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <!-- ペインヘッダ: どの agent のログかを示す (agent 名 + dim な id) -->
    <div class="flex shrink-0 items-baseline gap-2 border-b border-border-subtle px-4 py-1.5">
      <span class="min-w-0 truncate text-xs font-medium text-foreground" :title="title">
        {{ title }}
      </span>
      <span
        v-if="modelLabel !== ''"
        class="max-w-[40%] shrink-0 self-center truncate rounded-sm bg-panel px-1.5 py-0.5 text-[10px] font-medium text-foreground"
        :title="modelLabel"
      >
        {{ modelLabel }}
      </span>
      <span
        v-if="versionLabel !== ''"
        class="shrink-0 self-center truncate text-[10px] text-foreground-low tabular-nums"
        :title="versionLabel"
      >
        {{ versionLabel }}
      </span>
      <span
        v-if="subtitle !== undefined && subtitle !== ''"
        class="min-w-0 truncate text-[10px] text-foreground-low tabular-nums"
        :title="subtitle"
      >
        {{ subtitle }}
      </span>
      <!-- 生 jsonl を preview で開く。filePath を渡された dialog 経路だけ出す。 -->
      <button
        v-if="filePath !== undefined && filePath !== ''"
        type="button"
        aria-label="Open log file in preview"
        title="Open log file in preview"
        class="ml-auto grid size-5 shrink-0 place-items-center self-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="emit('open-file', filePath)"
      >
        <IconLucideFileJson class="size-3.5" />
      </button>
    </div>

    <!-- 本文: 空ログメッセージ or トランスクリプト -->
    <p v-if="parsed.events.length === 0" class="px-4 py-3 text-sm text-foreground-low">
      Session log has no conversation events.
    </p>

    <!-- トランスクリプト本文 (LINE 風チャット)。現在地は横断タイムラインの playhead が示す。
         会話本文はコピー対象コンテンツなので select-text で選択可にする (assistant の markdown は
         MarkdownBody 側で text、user / ask / tool I/O の plain text はここで担保)。
         折りたたみ操作の summary だけは内側で select-none を保ち、操作と選択を分離する。 -->
    <div
      v-else
      ref="contentRef"
      class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 select-text"
    >
      <template v-for="(ev, i) in parsed.events" :key="`${sessionKey}:${i}`">
        <!-- rewind 分岐セレクタ: ここで会話が枝分かれした。番号は古い順 (最新が最大)。
               選択中の枝をハイライトし、他をクリックでその枝へ切り替える。捨て枝が
               存在することの可視化と、過去バージョンの閲覧を兼ねる。 -->
        <div
          v-if="ev.kind === 'branch'"
          :data-ev="i"
          class="mx-auto flex w-fit max-w-[85%] scroll-mt-2 flex-wrap items-center justify-center gap-1.5 py-1 text-[11px] text-foreground-low"
        >
          <IconLucideGitBranch class="size-3.5 shrink-0" />
          <button
            v-for="opt in ev.options"
            :key="opt.childUuid"
            type="button"
            class="flex max-w-[200px] items-center gap-1 rounded-full border px-2 py-0.5"
            :class="
              opt.childUuid === ev.selectedChildUuid
                ? 'border-success bg-success-subtle text-success-text'
                : 'border-border text-foreground-low hover:bg-element-hover hover:text-foreground'
            "
            :title="opt.lead"
            @click="selectBranchOption(ev, opt)"
          >
            <span class="shrink-0 tabular-nums">#{{ opt.index }}</span>
            <span v-if="opt.lead !== ''" class="min-w-0 truncate">{{ opt.lead }}</span>
          </button>
        </div>

        <!-- ask (AskUserQuestion): assistant の質問 + user の回答を 1 ブロックに畳む。
               複数 question を取りうるので、それぞれを (質問吹き出し + 選択肢 chip 列 +
               回答吹き出し) のセットで縦に並べる。回答未充填 (resume 中断) は user 吹き出しの
               代わりに dim な「(no response)」を出す。選択肢を出すのは dialog だけで、
               terminal preview 側は flattenAskToMessages で text のみ抽出する。 -->
        <div v-else-if="ev.kind === 'ask'" :data-ev="i" class="scroll-mt-2 space-y-3">
          <div v-for="(q, qi) in ev.questions" :key="qi" class="space-y-1.5">
            <!-- 質問本体 (assistant 左寄せ吹き出し) -->
            <div class="flex items-end gap-1.5">
              <div
                class="min-w-0 rounded-2xl bg-chat-incoming px-3 py-1.5 text-sm wrap-break-word whitespace-pre-wrap text-chat-incoming-text"
              >
                <!-- header があれば質問の上にバッジで出す (元データの "次のステップ" 等) -->
                <p
                  v-if="q.header !== ''"
                  class="mb-1 text-[10px] font-medium text-chat-incoming-text-low"
                >
                  {{ q.header }}
                </p>
                {{ q.question }}
              </div>
              <SessionLogTimestamp :ts="ev.ts" align="left" />
            </div>

            <!-- 選択肢 (assistant 側に寄せる)。multiSelect は見出しに小さく明示。
                   選択された option を success 色でハイライトし、それ以外は dim に倒す。 -->
            <ul v-if="q.options.length > 0" class="ml-2 space-y-1">
              <li
                v-for="(opt, oi) in q.options"
                :key="oi"
                class="flex max-w-[85%] flex-col gap-0.5 rounded-md border px-2 py-1 text-xs"
                :class="
                  q.answer !== undefined && opt.label === q.answer
                    ? 'border-success bg-success-subtle text-success-text'
                    : 'border-border-subtle bg-panel text-foreground-low'
                "
              >
                <span class="font-medium">{{ opt.label }}</span>
                <span v-if="opt.description !== ''" class="text-foreground-low">
                  {{ opt.description }}
                </span>
              </li>
            </ul>

            <!-- 回答 (user 右寄せ吹き出し)。未充填 (resume 中断) は dim placeholder。 -->
            <div class="flex flex-row-reverse items-end gap-1.5">
              <div
                v-if="q.answer !== undefined"
                class="min-w-0 rounded-2xl bg-chat-outgoing px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-chat-outgoing-text"
              >
                {{ q.answer }}
              </div>
              <span
                v-else
                class="rounded-2xl bg-panel px-3 py-1.5 text-xs text-foreground-low italic"
              >
                (no response)
              </span>
              <SessionLogTimestamp :ts="ev.ts" align="right" />
            </div>
          </div>
        </div>

        <!-- thinking / tool: 中央寄せの控えめなシステム行 (デフォルト閉じ) -->
        <details
          v-else-if="ev.kind === 'thinking' || ev.kind === 'tool'"
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
            class="mx-auto flex w-fit max-w-[70%] cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-foreground-low select-none hover:bg-element-hover [&::-webkit-details-marker]:hidden"
          >
            <span v-if="ev.kind === 'thinking'">thinking</span>
            <template v-else>
              <!-- tool 名 = primary (weight)。error は引数 truncate に押し出されないよう名直後。 -->
              <span class="shrink-0 font-mono font-medium text-foreground">{{ ev.name }}</span>
              <span
                v-if="ev.result?.isError"
                class="shrink-0 rounded-sm bg-destructive-subtle px-1 whitespace-nowrap text-destructive-text"
                >error</span
              >
              <SessionLogToolArg :input="ev.input" />
              <!-- Agent / SendMessage / Workflow が subagent に結べるなら開くボタン、
                   結べるはずなのに解決できなかった場合は警告アイコンを出す
                   (resolved/unresolved/entry 無しの3値は buildSubagentLinks が既に判定済み)。 -->
              <SessionLogSubagentButton
                :result="subagentLinkFor(ev.toolUseId)"
                :ts="ev.ts"
                @open="emit('open-subagent', $event)"
              />
            </template>
          </summary>

          <!-- thinking 平文 -->
          <div
            v-if="ev.kind === 'thinking'"
            class="mx-auto mt-1 max-w-[85%] rounded-md bg-element-hover px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-foreground-low"
          >
            {{ ev.text }}
          </div>
          <!-- tool: input 全体 + 実行結果 -->
          <div
            v-else
            class="mx-auto mt-1 max-w-[85%] space-y-2 rounded-md bg-element-hover px-3 py-2"
          >
            <pre
              class="overflow-x-auto rounded-sm bg-panel p-2 text-xs text-foreground"
            ><code>{{ formattedInputs.get(i) }}</code></pre>
            <div v-if="ev.result">
              <p class="mb-1 text-[10px] text-foreground-low">
                {{ ev.result.isError ? "Error output" : "Output" }}
              </p>
              <pre
                class="max-h-72 overflow-auto rounded-sm bg-panel p-2 text-xs"
                :class="ev.result.isError ? 'text-destructive-text' : 'text-foreground'"
              ><code>{{ ev.result.text }}</code></pre>
            </div>
            <p v-else class="text-[10px] text-foreground-low italic">(no result recorded)</p>
          </div>
        </details>

        <!-- teammate: 他の Claude セッション (peer) からの発話。user/assistant の吹き出しとは
               別レーンで、summary を見出しにし本文を markdown 描画する。 -->
        <div
          v-else-if="ev.kind === 'teammate'"
          :data-ev="i"
          class="flex scroll-mt-2 flex-col gap-1 rounded-2xl border border-border-subtle bg-panel px-3 py-2"
        >
          <div class="flex items-center gap-1.5 text-xs font-medium text-foreground-low">
            <IconLucideUsers class="size-3.5 shrink-0" />
            <span class="min-w-0 truncate" :title="teammateHeader(ev)">{{
              teammateHeader(ev)
            }}</span>
          </div>
          <MarkdownBody
            :content="ev.text"
            @link-click="onAssistantLinkClick"
            @rendered="onMarkdownRendered"
          />
          <SessionLogTimestamp :ts="ev.ts" align="left" />
        </div>

        <!-- user / image (自分, 右寄せ) と assistant (相手, 左寄せ) の吹き出し。
               話者は左右寄せ + 緑/zinc の塗り分けで識別でき、アバターは置かない。 -->
        <div
          v-else
          :data-ev="i"
          class="flex scroll-mt-2 items-end gap-1.5"
          :class="ev.kind === 'assistant' ? 'flex-row' : 'flex-row-reverse'"
        >
          <!-- assistant: markdown 吹き出し (相手色 = chat-incoming = 暗グレー)。
                 LINE ダーク風の暗背景に明文字で、`--color-foreground` / `--color-foreground-low`
                 を chat-incoming-text 系で local override し、MarkdownBody 内の :deep セレクタ
                 が当てる文字色を明側へ寄せる。inline code は背景なし + 明 violet (scoped
                 :deep(code) で chat-code を当てる)。 -->
          <div
            v-if="ev.kind === 'assistant'"
            class="_transcript-assistant min-w-0 rounded-2xl bg-chat-incoming px-3 py-1.5 text-sm text-chat-incoming-text [--color-foreground-low:var(--color-chat-incoming-text-low)] [--color-foreground:var(--color-chat-incoming-text)] [--md-code-bg:transparent]"
          >
            <MarkdownBody
              :content="ev.text"
              @link-click="onAssistantLinkClick"
              @rendered="onMarkdownRendered"
            />
          </div>

          <!-- user: 素テキスト吹き出し (自分色 = chat-outgoing = LINE 緑、文字は chat-outgoing-text = 黒)。 -->
          <div
            v-else-if="ev.kind === 'user'"
            class="min-w-0 rounded-2xl bg-chat-outgoing px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-chat-outgoing-text"
          >
            {{ ev.text }}
          </div>

          <!-- image: 吹き出し背景なしで素の角丸画像。source 不明なら placeholder。
                 parse は検証済み {mediaType,base64} までを載せ、HTML 固有の data: URL 化は view で行う。 -->
          <img
            v-else-if="ev.kind === 'image' && ev.source"
            :src="imageDataUrl(ev.source)"
            alt="session log image"
            class="max-h-96 max-w-[75%] rounded-2xl border border-border"
          />
          <span
            v-else-if="ev.kind === 'image'"
            class="max-w-[75%] rounded-2xl bg-panel px-3 py-2 text-sm text-foreground-low italic"
            >(image content unavailable)</span
          >

          <!-- 時刻は吹き出しの下端脇に小さく。別日は日付 / 時刻を 2 行に分け、
                 隣接する吹き出し側 (assistant=左 / user=右) に寄せる。 -->
          <SessionLogTimestamp :ts="ev.ts" :align="ev.kind === 'assistant' ? 'left' : 'right'" />
        </div>
      </template>

      <!-- 追従が外れている間に更新が来たら下部に通知ボタン。クリックで最新へ飛ぶ。
             sticky でスクロールポート下端に固定し、flex のサイズ計算には干渉させない。
             wrapper は pointer-events-none で下の本文クリックを通し、ボタンだけ拾う。 -->
      <div
        v-if="showNewUpdates"
        class="pointer-events-none sticky bottom-3 z-10 flex justify-center"
      >
        <button
          type="button"
          class="pointer-events-auto flex items-center gap-1 rounded-full border border-border-strong bg-panel px-3 py-1 text-xs text-foreground shadow-lg hover:bg-element"
          @click="jumpToLatest"
        >
          <IconLucideArrowDown class="size-3.5" />
          New updates
        </button>
      </div>
    </div>

    <!-- フッタ (このペインの統計) -->
    <div
      class="shrink-0 border-t border-border-subtle px-4 py-2 text-[10px] text-foreground-low tabular-nums"
    >
      {{ footerSummary }}
    </div>
  </div>
</template>

<style scoped>
/* MarkdownBody は :deep(code) で固定色 (var(--color-foreground)) を当てるため、
   wrapper 側の text-* utility では inline code 色を上書きできない。assistant 吹き出し
   scope に :deep(code) を足して specificity を持ち上げ、chat-code (紫) で塗る。 */
._transcript-assistant :deep(code) {
  color: var(--color-chat-code);
}
</style>
