<doc lang="md">
ターミナル右上に常駐する Claude session の最新メッセージ preview。

`leafId` から PTY → session_id を辿り、`useSessionLogLive` で session ログをライブ取得する
(SessionLogDialog と同じ composable / 同じ debounce regimen)。

## 表示

main / sub を独立した 2 つの overlay に分け、terminal の右上に main、右下に sub を
配置する。1 つの overlay に縦積みすると main と sub の境界が読み取りにくいため、
物理的距離で分離する設計。

各 overlay の内側は「応答 (run)」単位で表示する。連続する同 kind の発言を 1 つの run と
して束ね、user / assistant それぞれ最新 3 run を表示対象にする。各 run は最後の発言
1 件で代表させ、assistant が応答中 (ログ末尾の run が assistant) のときだけ、その run を
末尾 3 件まで展開する (進行中の連続応答の流れを見せるため。user が最新なら応答は完結して
いるので全 run を畳む)。AskUserQuestion (`kind:"ask"` イベント) は `expandAskMessages` で
「質問 = assistant 発言」「回答 = user 発言」に inline 展開してから user / assistant のみを
filter で残す (preview は会話テキストだけ見せたいので thinking / tool / image / branch
ごと捨てる)。選択肢は parser 側で本来落とさないため、ここでは ask 展開の副作用ではなく
filter の責務として捨てている (parser 側に preview 表示制約を持ち込まないため)。回答
未充填 (resume 中断) の question は質問だけ残り、回答側は欠落する。user は右寄せ + `bg-chat-outgoing` (LINE 緑) + 黒文字、assistant は
左寄せ + `bg-chat-incoming` (暗グレー) + 白文字の LINE ダーク風吹き出し。角丸は対称
(話者方向を示す尖り角は付けない)。

run 単位で kind ごとに件数を確保するため、assistant が連続応答するケースでも user の
最近の発言が落ちず、対話の流れが追える。表示順は events の出現順そのまま (上から下が
時間の経過方向)。各 bubble は span ラップした
`line-clamp-2` で 2 行省略する (WebKit の button native renderer が
`-webkit-box-orient: vertical` を無視するため、button 直下では line-clamp が効かず
中間 span に逃がしている)。bubble が 0 件の overlay は非表示にし、両 overlay とも空なら
何も描画しない。

## 進行中インジケータ

各 overlay の bubble 列末尾に、「発言以外のアクション中」なら `・` が増減する typing
indicator (`_fx-typing-dots`) を assistant 吹き出しと同じ見た目で追加表示する。transcript
ベースの判定は `isSessionInProgress` (`terminalSessionPreviewMessages.ts`) が担い、ask 展開後の
events 列の末尾 kind が thinking / tool なら進行中、user / assistant (発言) なら false
にリセットする。system (注入) はエージェントのアクションでも発言でもないため末尾判定で透過し、
直近の非 system イベントで判定する (tool 実行中の hook 注入で進行中表示が誤って消えないように)。
preview は user/assistant/teammate 以外を filter で捨てるため、この判定だけは
filter 前の events 列 (`parsePreview` の中間結果) を見る必要がある。

main と sub で判定の確からしさが非対称になる。main は PTY を持ち、ClaudeStatus
(`claudeStatus.ts`) が hooks + PTY 出力の interrupt パターンマッチで「本当に working か」を
継続的に更新している。ユーザーが Ctrl+C/Escape で中断すると Claude Code は transcript に
新規イベントを追記しない (interrupt 通知フックが無いため) ので、transcript 末尾だけで判定
すると次の発言まで進行中表示が居座り続けて ClaudeStatus の badge (idle) と食い違う。そのため
`mainInProgress` は `isSessionInProgress` の結果を `ClaudeStatus` (`getClaudeState(leafId)
=== "working"`) で AND し、より確からしい信号を優先する。sub は Task ツールで起動される
仮想セッションで PTY / ClaudeStatus を持たないため、transcript ベースの推定のみで妥協する。

## 折りたたみと高さ上限

main / sub とも `<details><summary>` で bubble 群を折りたためる。summary は main が
固定ラベル "Main"、sub が `subagentTabLabel` 由来の subagent ラベル (Task / workflow
agent。空文字フォールバックは "Subagent")。開閉状態は Vue 側 ref
(`mainOpen` / `subOpen`) が SSOT。`open` 属性そのものを SSOT にすると v-if / subagent
切替の unmount → mount で静的 `open` に戻ってしまうため、`:open` バインド + `@toggle`
同期にしている。

スクロール面は summary の外に出さず、details 内の wrapper div に閉じる (summary は
スクロールせず、bubble と被らない)。details 自体にはスタイルを当てず、native の
open/close と summary 表示制御だけに使う。wrapper の高さ上限は `max-h-[calc(50cqh-2rem)]`。
% は details (block / auto 高) を跨いで伝播しないため、TerminalLeaf の relative コンテナを
`container-type: size` にして cqh で leaf 高さを直接参照する。50cqh から 2rem を引くのは
summary 高 (約 1.5rem) + 上下 inset 分の予算で、各 overlay 全体 (summary + wrapper) が
leaf の 50% に収まる。main + sub が両方最大高でも合算が leaf を超えず、重ならない。
wrapper の `flex-col-reverse` は
単一子 (bubble 列) の並びには影響せず、scroll の初期位置と anchor を末尾 (最新発言)
側に倒すための指定。wrapper は `pointer-events-auto` の通常の scroll container として
振る舞い、bubble の隙間でも wheel は overlay のスクロールになる (`pointer-events-none`
でヒットテストだけ透過させると、wheel の標準動作「target から最も近い scrollable
ancestor をスクロール」がターミナルに向いてしまう)。root の余白 (padding) だけは
従来どおり `pointer-events-none` でターミナルへ透過する。

## 全文 preview

各 bubble クリックで HTML Popover API ベースの全文ポップオーバーを開く。popover ヘッダの
pin ボタンクリック、またはヘッダのドラッグ (しきい値超過) で、表示中メッセージを
スナップショットとして独立フローティングウィンドウ (session-log feature の
`usePinnedLog` / PinnedLogLayer) に固定化できる。ドラッグ経路は pin 元の rect と掴んだ
pointer を `PinDragHandoff` でウィンドウへ引き継ぎ、popover を掴んでそのまま引き剥がす
操作感にする。popover 自体は anchor (bubble) に寄生し light-dismiss で消える一時 UI
なので、「残したい」要求は別レイヤーへ昇格させる設計。Popover は
`shared/popover` の `usePopover` を per-instance で使い、anchor は被クリック bubble。
CSS anchor positioning (`positionArea` + `positionTryFallbacks`) で画面端に押し出された
ときは反対側へ flip する。同じ bubble を再クリックすると閉じる (トグル)。

開く向きのデフォルトは由来 overlay によって反転させる。main 由来 (画面上側 bubble) は
`block-end` で anchor の下に、sub 由来 (画面下側 bubble) は `block-start` で anchor の
上に開く。下側 bubble の真下は画面端に近く即 flip 前提のレイアウトになるため、初期向きを
上にしておくことで「open 直後に flip して位置が跳ねる」視覚的なちらつきを構造的に消す。
flip 規則 (`positionTryFallbacks`) は両 origin で共通のため、開いた後の縁ぶつかり時の
逆転挙動は維持される。

DOM 構造は三段:

- 外側 popover element (`bg-transparent border-none overflow-visible px-0 py-3` のみ)
  位置決めと縦 padding だけを担う透明枠。UA default の `[popover] { overflow: auto }` は
  `overflow-visible` で明示的に打ち消す (打ち消さないと内側 box の `shadow-xl` が外側
  border-box で clip され shadow がほぼ見えなくなる)
- 中間 box (`max-h-[60vh] flex-col overflow-hidden rounded-md border border-border-strong
shadow-xl` + kind 別 `bg-chat-incoming` / `bg-chat-outgoing`)
  共通の「角丸 + border + shadow」と kind 別の bg を担う flex-col の二段構成。上段は
  pin ボタンを置くヘッダ、下段が `overflow-auto` のスクロール面。pin ボタンをスクロール
  領域の外に出すことで縦スクロールバーとの被りを構造的に消す (スクロール container 内の
  absolute 配置は内容と一緒にスクロールし、overlay 配置はスクロールバー上に重なる)。
  `overflow-hidden` + `border-radius` は CSS Backgrounds Module Level 3 §5.3
  (Corner Clipping) で子の painting を clip するため、bg / ヘッダは角丸内に収まる
- 内側 box (`SessionLogMessageBody`。kind 別の本文描画、bg は持たない)
  user は素テキスト、assistant は MarkdownBody + chat 配色。PinnedLogWindow と共有する
  (`:deep(code)` の specificity 回避策含め session-log feature 側に集約)。背景は wrapper
  から透ける構造

「位置決め (外) / 見た目 + スクロール (中間) / 配色 (内)」と責務を分けることで、外側に
装飾が混入して bubble overlay と区別できなくなる二重背景や、scroll 面が外側に寄って内側
box が伸び続ける挙動を構造的に排除する。
</doc>

<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import { usePopover } from "../../shared/popover";
import { taskDisplayTitle, useRepoStore } from "../../shared/repo";
import {
  expandAskMessages,
  parseSessionLog,
  SessionLogMessageBody,
  usePinnedLog,
  useSessionLogLive,
  type PinDragHandoff,
} from "../session-log";
import type { PreviewEvent, PreviewMessage } from "./terminalSessionPreviewMessages";
import { collectMessages, isSessionInProgress } from "./terminalSessionPreviewMessages";
import { useTerminalStore } from "./useTerminalStore";
import IconLucidePin from "~icons/lucide/pin";

interface Props {
  leafId: string;
}

const props = defineProps<Props>();
const terminalStore = useTerminalStore();
const repoStore = useRepoStore();

// leafId → ptyId → sessionId の辿り。`sessionIdByPtyId` は reactive Map なので
// `getSessionIdByPtyId` の結果がそのまま reactivity に乗る。session-start で entry が
// 立った時点で computed が再評価され、session-end での delete でも追随する。
const sessionId = computed<string | undefined>(() => {
  const ptyId = terminalStore.getPtyId(props.leafId);
  if (ptyId === undefined) return undefined;
  return terminalStore.getSessionIdByPtyId(ptyId);
});

const { sessions } = useSessionLogLive(sessionId);

// JSONL を都度 parse する。preview は最新の会話発話だけを run 単位で見せるため
// branchSelection は不要 (parseSessionLog は未指定で最新枝にフォールバックする)。
//
// `expandAskMessages` で AskUserQuestion (kind: "ask") を「質問 = assistant 発言」
// 「回答 = user 発言」に inline 展開する。展開後の events 列から user / assistant 以外
// (thinking / tool / image / branch) を捨てるのは preview 側の責務 (どの kind を見せるかは
// 表示制約。parser 側は ask 展開のみに閉じる)。inProgress は展開後・filter 前の events 列
// (末尾が thinking / tool かどうか) から判定するため、messages と同じ 1 回の parse 結果を
// 両方の派生元にする。
interface ParsedPreview {
  messages: PreviewEvent[];
  inProgress: boolean;
}

function parsePreview(content: string): ParsedPreview {
  const events = expandAskMessages(parseSessionLog(content).events);
  const messages: PreviewEvent[] = [];
  for (const ev of events) {
    if (ev.kind === "user" || ev.kind === "assistant") {
      messages.push({ kind: ev.kind, text: ev.text, ts: ev.ts });
    } else if (ev.kind === "teammate") {
      // peer セッションからの受信発話は、この agent への inbound 入力として user 扱いで見せる
      // (subagent の spawn prompt も teammate でラップされるため、これを落とすと preview から消える)。
      messages.push({ kind: "user", text: ev.text, ts: ev.ts });
    }
  }
  return { messages, inProgress: isSessionInProgress(events) };
}

// 最後に「会話発話」(kind === user | assistant) があった ts。tool だけ走り続けている
// subagent (大規模 grep / spawn) はここの最新性に寄与させない。tool ts まで含めると
// 実際に対話している subagent が押し出されて preview の主役が反転するため。
function lastConversationTs(events: PreviewEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const ms = Date.parse(e.ts);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

// main session の parse 結果 (messages + inProgress)。サブで二度評価されるのを避けるため
// computed に切る。
const mainParsed = computed<ParsedPreview>(() => {
  const main = sessions.value.find((s) => s.kind === "main");
  return main === undefined ? { messages: [], inProgress: false } : parsePreview(main.content);
});
// transcript 末尾が thinking/tool でも、ユーザーが Ctrl+C/Escape で中断した直後は
// Claude Code が transcript に新規イベントを追記しない (interrupt 通知フックが無いため。
// docs/claude-status.md 参照)。この場合 `ClaudeStatus` は PTY 出力のパターンマッチで
// 既に idle に落ちているのに、transcript ベースの判定だけだと次の発言までインジケータが
// 居座り続けて食い違う。main は PTY を持つため `ClaudeStatus` (TerminalLeafTitle の badge と
// 同じ `getClaudeState`) で確定させ、transcript ベースの推定より優先する。
const mainInProgress = computed<boolean>(
  () => mainParsed.value.inProgress && terminalStore.getClaudeState(props.leafId) === "working",
);

// 最後に発話があった subagent 1 つの events + 表示ラベル (subagentTabLabel が組み立てた
// agent 名 / workflow 見出し) + inProgress。「発話」は会話イベント (user / assistant) の
// 最終 ts で判定し、tool 単独走行の subagent はここでの最新性に寄与させない。events と
// label を 1 つの computed にまとめておくと sub overlay の見出しと本文が同じ subagent から
// 派生する不変条件を構造的に担保できる。
const newestSub = computed<
  { label: string; events: PreviewEvent[]; inProgress: boolean } | undefined
>(() => {
  const subs = sessions.value
    .filter((s) => s.kind !== "main")
    .map((s) => {
      const parsed = parsePreview(s.content);
      return { label: s.label, events: parsed.messages, inProgress: parsed.inProgress };
    })
    .filter((x) => x.events.length > 0);
  if (subs.length === 0) return undefined;
  let newest = subs[0];
  let newestMs = lastConversationTs(newest.events);
  for (let i = 1; i < subs.length; i++) {
    const ms = lastConversationTs(subs[i].events);
    if (ms > newestMs) {
      newestMs = ms;
      newest = subs[i];
    }
  }
  return newest;
});
const subEvents = computed<PreviewEvent[]>(() => newestSub.value?.events ?? []);
// sub は Task ツールで起動される仮想セッションで PTY を持たず ClaudeStatus が存在しないため、
// main と異なり transcript ベースの推定 (`parsePreview` の inProgress) だけで判定する。
const subInProgress = computed<boolean>(() => newestSub.value?.inProgress ?? false);
// subLabel は <summary> の折り畳みハンドルを兼ねるため、subagentTabLabel が空文字
// を返すケース (ロード途中 / meta.json 解析失敗) でも "Subagent" にフォールバック
// して summary を必ず出す。summary を欠落させると UA デフォルト "Details" 表示に
// なり、クリックハンドルもユーザーにとって意味不明な文字列になる。
const subLabel = computed<string>(() => {
  const label = newestSub.value?.label;
  return label !== undefined && label !== "" ? label : "Subagent";
});

// bubble 選択は run 単位の純粋関数 `collectMessages` (terminalSessionPreviewMessages.ts) に
// 委譲する。選択規則の詳細はそちらのコメントとテストを参照。
const mainMessages = computed<PreviewMessage[]>(() => collectMessages(mainParsed.value.messages));
const subMessages = computed<PreviewMessage[]>(() => collectMessages(subEvents.value));

// クリックで全文を出す popover。kind は吹き出し色を合わせるための discriminator、
// origin は anchor が main / sub overlay どちらに属するかを popover の開く向きに反映するための
// discriminator (main は anchor の下に、sub は anchor の上に開く)。
// PreviewMessage に origin を載せて context として渡し、popover 側は kind / text / origin
// のみ参照する (ts は無視される)。型を分けず 1 つにまとめて conversion を消す。
// per-instance: コンポーネント unmount で effect scope が自動破棄されるため stop 不要。
interface PreviewContext {
  msg: PreviewMessage;
  origin: "main" | "sub";
}
const {
  Popover: PreviewPopover,
  context: previewContext,
  toggle: togglePreviewPopover,
  close: closePreviewPopover,
} = usePopover<PreviewContext>();

function togglePreview(event: MouseEvent, msg: PreviewMessage, origin: "main" | "sub") {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  togglePreviewPopover(anchor, { msg, origin });
}

// popover ヘッダの pin ボタン。表示中メッセージを pin 時点のスナップショットとして
// 独立フローティングウィンドウ (PinnedLogLayer) へ固定化する。ウィンドウは repo /
// session 切り替えを跨いで生存するため、タイトルに repo 名 + session タイトルを
// 焼き込んで出自を識別できるようにする。pin 後は popover を閉じる (二重表示を残さない)。
const { pin: pinLog } = usePinnedLog();

// pin 時の実測対象。位置は popover の中間 box の rect、サイズは本文 (スクロール面) の
// rect を固定ウィンドウへ引き継ぎ、popover がその場でフローティング化したような視覚的
// 連続性を出す。サイズを box の総高さでなく本文で渡すのは、ウィンドウ側のヘッダ
// (repo + タイトル 2 段) が popover のヘッダ (pin ボタン 1 行) より高く、総高さを
// 引き継ぐと増えたヘッダ分だけ本文が食われて切れるため (usePinnedLog の doc 参照)。
const previewBoxRef = useTemplateRef<HTMLElement>("previewBox");
const previewBodyRef = useTemplateRef<HTMLElement>("previewBody");

function pinPreview(handoff?: PinDragHandoff) {
  const ctx = previewContext.value;
  const box = previewBoxRef.value;
  const body = previewBodyRef.value;
  if (ctx === undefined || box === null || body === null) return;
  const rect = box.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  // ヘッダは TerminalLeafTitle と同じ SSOT から組み立てる: repo は dir → findRepoOwning
  // (name + RepoIcon 用 owner)、session タイトルは sessionId → findTaskBySessionId →
  // taskDisplayTitle。sub 由来はどの subagent かも識別できるよう subLabel を足す (main は
  // 自明なので略)。repo 未登録 / Task 未到達 (起動直後等) は解決できた部分だけで出す。
  const dir = terminalStore.getPaneDir(props.leafId);
  const repo = dir === undefined ? undefined : repoStore.findRepoOwning(dir);
  const sid = sessionId.value;
  // 空文字は未起動 / 切り離し済みで findTaskBySessionId が誤一致しうるため除外 (TerminalLeafTitle と同じ規律)
  const task = sid === undefined || sid === "" ? undefined : repoStore.findTaskBySessionId(sid);
  const sessionTitle = task === undefined ? undefined : taskDisplayTitle(task);
  const parts = [sessionTitle];
  if (ctx.origin === "sub") parts.push(subLabel.value);
  const title = parts.filter((p) => p !== undefined && p !== "").join(" · ");
  pinLog(
    {
      kind: ctx.msg.kind,
      repoName: repo?.repoName ?? "",
      repoOwner: repo?.githubIdentity?.owner ?? "",
      title: title === "" ? "Session log" : title,
      text: ctx.msg.text,
      x: rect.left,
      y: rect.top,
      bodyWidth: bodyRect.width,
      bodyHeight: bodyRect.height,
    },
    handoff,
  );
  closePreviewPopover();
}

/** popover ヘッダのドラッグを pin 化とみなすしきい値 (px)。pin ボタンのクリックと区別する。 */
const DRAG_PIN_THRESHOLD = 4;

// popover ヘッダのドラッグ検知。しきい値を超えたら pin して、掴んでいる pointer ごと
// PinnedLogWindow へドラッグを引き継ぐ (PinDragHandoff)。pin は rect を実測してから
// popover を閉じるので、ウィンドウは掴んだその位置に現れてそのまま動かせる。
let headerDrag: { pointerId: number; startX: number; startY: number } | undefined;

function onPreviewHeaderPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const header = event.currentTarget;
  if (!(header instanceof HTMLElement)) return;
  // しきい値到達前に pointer がヘッダ外へ滑っても pointermove を受け続けるため capture する。
  // pin 発火で popover ごと閉じたときの capture は UA が自動解放する。
  header.setPointerCapture(event.pointerId);
  headerDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
}

function onPreviewHeaderPointerMove(event: PointerEvent) {
  if (headerDrag === undefined || event.pointerId !== headerDrag.pointerId) return;
  const dx = event.clientX - headerDrag.startX;
  const dy = event.clientY - headerDrag.startY;
  if (Math.hypot(dx, dy) < DRAG_PIN_THRESHOLD) return;
  const box = previewBoxRef.value;
  if (box === null) return;
  // オフセットは掴んだ瞬間 (pointerdown) の位置基準。しきい値超過時点の位置基準にすると
  // 引き継ぎ直後にしきい値分だけウィンドウが跳ねる。
  const rect = box.getBoundingClientRect();
  const grab = headerDrag;
  headerDrag = undefined;
  pinPreview({
    pointerId: event.pointerId,
    offsetX: grab.startX - rect.left,
    offsetY: grab.startY - rect.top,
  });
}

function onPreviewHeaderPointerUp(event: PointerEvent) {
  if (headerDrag?.pointerId !== event.pointerId) return;
  headerDrag = undefined;
}

// 各 overlay の折り畳み状態。`<details>` の `open` 属性を SSOT にすると v-if /
// subagent 切替で <details> が unmount → mount される度に静的 `open` で展開状態に
// 戻ってしまうため、Vue 側 ref を SSOT にして `<details :open>` でバインドし、
// `@toggle` で同期する。
const mainOpen = ref(true);
function onMainToggle(event: Event) {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  mainOpen.value = event.target.open;
}
const subOpen = ref(true);
function onSubToggle(event: Event) {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  subOpen.value = event.target.open;
}

// 各 overlay は bubble が 1 件でもあれば出す。session が無いときは events が空なので
// collectMessages も空配列を返し、副次的にカバーされる。
const hasMain = computed(() => mainMessages.value.length > 0);
const hasSub = computed(() => subMessages.value.length > 0);
</script>

<template>
  <!-- main: 右上。最新 3 応答分 (run 単位) を時系列順に LINE 風吹き出しで並べる。
       key に index を含めるのは、最新 assistant run の連続発言が同一 ts を持ち得るため -->
  <div
    v-if="hasMain"
    class="pointer-events-none absolute top-1 right-3 z-10 w-56 max-w-[35%] overflow-hidden rounded-md bg-background/70 text-xs/tight"
  >
    <details :open="mainOpen" @toggle="onMainToggle">
      <summary
        class="pointer-events-auto cursor-pointer truncate bg-element-hover px-2 py-1 text-xs font-semibold text-foreground-low hover:bg-element-active [&::-webkit-details-marker]:hidden [&::marker]:hidden"
      >
        Main
      </summary>
      <!-- スクロール面は summary の外に出さず details 内の wrapper に閉じる (summary と
           被らない)。高さ上限は % が details (block / auto 高) を跨いで伝播しないため、
           leaf (TerminalLeaf の container-type: size) を参照する cqh で直接指定する。
           flex-col-reverse は単一子 (bubble 列) の並びには影響せず、scroll 初期位置 /
           anchor を末尾 (最新発言) に倒すための指定。wrapper は pointer-events-auto の
           通常の scroll container (bubble の隙間でも wheel が overlay のスクロールに
           なる)。root の余白だけが pointer-events-none でターミナルへ透過する -->
      <div
        class="pointer-events-auto flex max-h-[calc(50cqh-2rem)] flex-col-reverse overflow-y-auto p-2"
      >
        <div class="flex flex-col gap-1">
          <div
            v-for="(msg, i) in mainMessages"
            :key="`${i}-${msg.kind}-${msg.ts}`"
            class="flex min-w-0"
            :class="msg.kind === 'user' ? 'justify-end' : ''"
          >
            <button
              type="button"
              class="block max-w-[85%] cursor-pointer rounded-lg px-2 py-1 text-left hover:brightness-110"
              :class="
                msg.kind === 'user'
                  ? 'bg-chat-outgoing text-chat-outgoing-text'
                  : 'bg-chat-incoming text-chat-incoming-text'
              "
              :title="msg.text"
              @click="togglePreview($event, msg, 'main')"
            >
              <span class="line-clamp-2">{{ msg.text }}</span>
            </button>
          </div>
          <!-- 進行中インジケータ。transcript 末尾が thinking / tool (発言以外のアクション)
               のときだけ出し、次の発言が来た瞬間 mainInProgress が false になって消える
               (発言でリセット)。会話バブルの続きに見えるよう assistant 側と同じ吹き出し。 -->
          <div v-if="mainInProgress" class="flex min-w-0">
            <div
              class="block rounded-lg bg-chat-incoming px-2 py-1 text-chat-incoming-text"
              role="status"
              aria-label="Working"
            >
              <span class="_fx-typing-dots inline-block w-9 text-center"></span>
            </div>
          </div>
        </div>
      </div>
    </details>
  </div>

  <!-- sub: 右下。main と同じ LINE 風シーケンス + 同じ max-h スクロール / 折りたたみ構造。
       物理的距離で main との混在を回避する。summary は subagentTabLabel が組み立てた
       agent 名 / workflow 見出しで、どの subagent の発話なのかを明示する。 -->
  <div
    v-if="hasSub"
    class="pointer-events-none absolute right-3 bottom-1 z-10 w-56 max-w-[35%] overflow-hidden rounded-md bg-background/70 text-xs/tight"
  >
    <details :open="subOpen" @toggle="onSubToggle">
      <summary
        class="pointer-events-auto cursor-pointer truncate bg-element-hover px-2 py-1 text-xs font-semibold text-foreground-low hover:bg-element-active [&::-webkit-details-marker]:hidden [&::marker]:hidden"
        :title="subLabel"
      >
        {{ subLabel }}
      </summary>
      <!-- bubble 用の内側コンテナ。details に直接 flex / gap を当てると WebKit で
           generated content の gap 計算が崩れる挙動があるため、details はネイティブの
           open/close と summary 表示制御だけに使い、レイアウト / スクロールは中の div に
           閉じる。wrapper の構造は main と同じ。 -->
      <div
        class="pointer-events-auto flex max-h-[calc(50cqh-2rem)] flex-col-reverse overflow-y-auto p-2"
      >
        <div class="flex flex-col gap-1">
          <div
            v-for="(msg, i) in subMessages"
            :key="`${i}-${msg.kind}-${msg.ts}`"
            class="flex min-w-0"
            :class="msg.kind === 'user' ? 'justify-end' : ''"
          >
            <button
              type="button"
              class="block max-w-[85%] cursor-pointer rounded-lg px-2 py-1 text-left hover:brightness-110"
              :class="
                msg.kind === 'user'
                  ? 'bg-chat-outgoing text-chat-outgoing-text'
                  : 'bg-chat-incoming text-chat-incoming-text'
              "
              :title="msg.text"
              @click="togglePreview($event, msg, 'sub')"
            >
              <span class="line-clamp-2">{{ msg.text }}</span>
            </button>
          </div>
          <!-- 進行中インジケータ。main と同じ規律 (末尾が thinking / tool のときだけ表示)。 -->
          <div v-if="subInProgress" class="flex min-w-0">
            <div
              class="block rounded-lg bg-chat-incoming px-2 py-1 text-chat-incoming-text"
              role="status"
              aria-label="Working"
            >
              <span class="_fx-typing-dots inline-block w-9 text-center"></span>
            </div>
          </div>
        </div>
      </div>
    </details>
  </div>

  <!-- 全文 preview popover。anchor は被クリックの bubble、`positionTryFallbacks` で
       端に押し出されたら反対側へ flip。light-dismiss (popover 外 click / ESC) で閉じる。
       本文描画は SessionLogMessageBody に委譲 (assistant のみ markdown 解釈)。 -->
  <PreviewPopover
    class="m-0 w-3xl max-w-[80vw] overflow-visible border-none bg-transparent px-0 py-3 text-base"
    :style="{
      position: 'fixed',
      positionArea:
        previewContext?.origin === 'sub'
          ? 'block-start span-inline-start'
          : 'block-end span-inline-start',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="previewContext">
      <!-- 全文 popover はメッセージを読む / コピーする面なので select-text で選択可にする
           (compact な吹き出しプレビューは click-to-expand の chrome なのでデフォルト none のまま)。
           box は flex-col の「ヘッダ + スクロール面」二段構成。pin ボタンをスクロール領域の
           外 (ヘッダ) に出すことで、スクロールバーとの被りを構造的に消す。角丸内への
           painting clip は overflow-hidden が担う。 -->
      <div
        ref="previewBox"
        class="flex max-h-[60vh] flex-col overflow-hidden rounded-md border border-border-strong shadow-xl select-text"
        :class="previewContext.msg.kind === 'assistant' ? 'bg-chat-incoming' : 'bg-chat-outgoing'"
      >
        <!-- ヘッダはドラッグで pin 化 + そのまま移動できる (しきい値超過で発火)。
             pin ボタンは pointerdown.stop でドラッグ判定から外し、クリック pin を残す -->
        <div
          class="flex shrink-0 cursor-grab items-center justify-end border-b border-border bg-panel px-1 py-0.5 select-none"
          title="Drag to pin as floating window"
          @pointerdown="onPreviewHeaderPointerDown"
          @pointermove="onPreviewHeaderPointerMove"
          @pointerup="onPreviewHeaderPointerUp"
          @pointercancel="onPreviewHeaderPointerUp"
        >
          <button
            type="button"
            aria-label="Pin"
            title="Pin as floating window"
            class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
            @pointerdown.stop
            @click="pinPreview()"
          >
            <IconLucidePin class="size-3.5" />
          </button>
        </div>
        <div ref="previewBody" class="min-h-0 flex-1 overflow-auto">
          <SessionLogMessageBody :kind="previewContext.msg.kind" :text="previewContext.msg.text" />
        </div>
      </div>
    </template>
  </PreviewPopover>
</template>
