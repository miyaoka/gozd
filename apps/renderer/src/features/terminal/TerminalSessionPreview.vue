<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { usePopover } from "../../shared/popover";
import { sessionDisplayTitle, useRepoStore } from "../../shared/repo";
import type { UndockDragHandoff } from "../floating-window";
import {
  isSameSpeech,
  parseSessionLog,
  SessionLogMessageBody,
  SPEAKER_SURFACE_CLASS,
  type Speech,
  useUndockedLog,
  useSessionLogLive,
} from "../session-log";
import { stripClaudeTitlePrefix } from "./claudeStatus";
import { keepInPlace } from "./keepInPlace";
import {
  collectRuns,
  countInProgressActions,
  endsWithInterrupt,
  type PreviewRun,
  type PreviewSpeech,
  previewSpeeches,
  type RevealSide,
  runKey,
} from "./terminalSessionPreviewMessages";
import TerminalSessionPreviewProgressDots from "./TerminalSessionPreviewProgressDots.vue";
import TerminalSessionPreviewRun from "./TerminalSessionPreviewRun.vue";
import { useTerminalStore } from "./useTerminalStore";
import IconMdiDockWindow from "~icons/mdi/dock-window";

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
// events 列のうち吹き出しにするのは `previewSpeeches` が返す発言だけ。actionCount と interrupted は
// 吹き出し選別前の events 列 (末尾に積まれた tool の件数 / 直近のターン境界) から決めるため、speeches と
// 同じ 1 回の parse 結果を派生元にする。id は run の開閉状態の key に使い、発言と同じセッションログから取る。
interface ParsedPreview {
  /** セッションログ 1 本の id (main は session_id、sub は agent_id) */
  id: string;
  speeches: PreviewSpeech[];
  /** 直近のターン境界以降のアクション件数。0 なら進行中でない */
  actionCount: number;
  /** ログが中断で終わったか。中断で終わったログの末尾 run は応答中として展開しない */
  interrupted: boolean;
}

function parsePreview(log: { id: string; content: string }): ParsedPreview {
  const { events } = parseSessionLog(log.content);
  return {
    id: log.id,
    speeches: previewSpeeches(events),
    actionCount: countInProgressActions(events),
    interrupted: endsWithInterrupt(events),
  };
}

// 最後に発言があった ts。tool だけ走り続けている subagent (大規模 grep / spawn) はここの
// 最新性に寄与させない。tool ts まで含めると実際に対話している subagent が押し出されて
// preview の主役が反転するため。
function lastConversationTs(items: PreviewSpeech[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const ms = Date.parse(items[i].speech.ts);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

// main session の parse 結果 (speeches + actionCount)。サブで二度評価されるのを避けるため
// computed に切る。
const mainParsed = computed<ParsedPreview>(() => {
  const main = sessions.value.find((s) => s.kind === "main");
  return main === undefined
    ? { id: "", speeches: [], actionCount: 0, interrupted: false }
    : parsePreview(main);
});
// main は PTY を持つため `ClaudeStatus` (TerminalLeafTitle の badge と同じ `getClaudeState`) で
// 確定させ、transcript ベースの推定より優先する。transcript は記録を経由した推定で、badge と
// 食い違わないよう、より確からしい信号に揃える。
const mainActionCount = computed<number>(() =>
  terminalStore.getClaudeState(props.leafId) === "working" ? mainParsed.value.actionCount : 0,
);

// 最後に発言があった subagent 1 つの id + events + 表示ラベル (subagentLabel が組み立てた
// agent 名 / workflow 見出し) + actionCount。発言の最終 ts で判定し、tool 単独走行の
// subagent はここでの最新性に寄与させない。events と label を 1 つの computed にまとめておくと
// sub overlay の見出しと本文が同じ subagent から派生する不変条件を構造的に担保できる。
const newestSub = computed<
  | {
      id: string;
      label: string;
      events: PreviewSpeech[];
      actionCount: number;
      interrupted: boolean;
    }
  | undefined
>(() => {
  const subs = sessions.value
    .filter((s) => s.kind !== "main")
    .map((s) => {
      const parsed = parsePreview(s);
      return {
        id: parsed.id,
        label: s.label,
        events: parsed.speeches,
        actionCount: parsed.actionCount,
        interrupted: parsed.interrupted,
      };
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
const subEvents = computed<PreviewSpeech[]>(() => newestSub.value?.events ?? []);
// sub は Task ツールで起動される仮想セッションで PTY を持たず ClaudeStatus が存在しないため、
// main と異なり transcript ベースの推定 (`parsePreview` の actionCount) だけで判定する。
const subActionCount = computed<number>(() => newestSub.value?.actionCount ?? 0);
// subLabel は <summary> の折り畳みハンドルを兼ねるため、subagentLabel が空文字
// を返すケース (ロード途中 / meta.json 解析失敗) でも "Subagent" にフォールバック
// して summary を必ず出す。summary を欠落させると UA デフォルト "Details" 表示に
// なり、クリックハンドルもユーザーにとって意味不明な文字列になる。
const subLabel = computed<string>(() => {
  const label = newestSub.value?.label;
  return label !== undefined && label !== "" ? label : "Subagent";
});

// run への束ねと行の並びは純粋関数 `collectRuns` / `runRows` (terminalSessionPreviewMessages.ts)
// に委譲する。規則の詳細はそちらのコメントとテストを参照。
const mainRuns = computed<PreviewRun[]>(() =>
  collectRuns(mainParsed.value.speeches, mainParsed.value.interrupted),
);
const subRuns = computed<PreviewRun[]>(() =>
  collectRuns(subEvents.value, newestSub.value?.interrupted ?? false),
);

// 開いた発言をトグルのどちら側に出すか
const REVEAL_SIDE: Record<"main" | "sub", RevealSide> = {
  main: "below",
  sub: "above",
};

// 開いている run の key (`runKey`) の集合
const expandedRunKeys = ref(new Set<string>());

function logIdOf(origin: "main" | "sub"): string {
  if (origin === "main") return mainParsed.value.id;
  const sub = newestSub.value;
  if (sub === undefined) throw new Error("sub overlay has no session log");
  return sub.id;
}

function isRunExpanded(origin: "main" | "sub", run: PreviewRun): boolean {
  return expandedRunKeys.value.has(runKey(logIdOf(origin), run));
}

const mainScrollerRef = useTemplateRef<HTMLElement>("mainScroller");
const subScrollerRef = useTemplateRef<HTMLElement>("subScroller");

async function toggleRun(origin: "main" | "sub", run: PreviewRun, anchor: HTMLElement) {
  const scroller = origin === "main" ? mainScrollerRef.value : subScrollerRef.value;
  if (scroller === null) throw new Error(`${origin} overlay has no scroller`);
  const key = runKey(logIdOf(origin), run);
  await keepInPlace(anchor, scroller, async () => {
    // delete が false (= 閉じていた) なら開く
    if (!expandedRunKeys.value.delete(key)) expandedRunKeys.value.add(key);
    await nextTick();
  });
}

// クリックで全文を出す popover。origin は anchor が main / sub overlay のどちらに属するかで、
// popover の開く向きに使う (main は anchor の下に、sub は anchor の上に開く)。
// per-instance: コンポーネント unmount で effect scope が自動破棄されるため stop 不要。
interface PreviewContext {
  msg: Speech;
  origin: "main" | "sub";
}
const {
  Popover: PreviewPopover,
  context: previewContext,
  open: openPreviewPopover,
  close: closePreviewPopover,
} = usePopover<PreviewContext>();

// popover の anchor に使う proxy。クリック時点の bubble rect を overlay root 相対で写し、
// bubble の代わりに寄生先にする。
const mainAnchorProxyRef = useTemplateRef<HTMLElement>("mainAnchorProxy");
const subAnchorProxyRef = useTemplateRef<HTMLElement>("subAnchorProxy");
const anchorRect = ref<{
  origin: "main" | "sub";
  x: number;
  y: number;
  width: number;
  height: number;
}>();
const anchorProxyStyle = computed(() => {
  const r = anchorRect.value;
  if (r === undefined) return undefined;
  return {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
});

// anchor が毎回同一 proxy になるため、usePopover の要素同一性 toggle は使えない。
// 再クリックで閉じるトグルは、表示中と同じ overlay の同じ発言かで判定する。
function isShowingPreview(msg: Speech, origin: "main" | "sub"): boolean {
  const ctx = previewContext.value;
  if (ctx === undefined) return false;
  return ctx.origin === origin && isSameSpeech(ctx.msg, msg);
}

function togglePreview(anchor: HTMLElement, msg: Speech, origin: "main" | "sub") {
  // 同 message の再クリックは close。light-dismiss (pointerdown) が click より先に popover を
  // 閉じていても、@toggle "closed" は task-queued で context がまだ残っているため同期判定できる
  // (usePopover.toggle と同じ理屈)。hidePopover は dismiss 済みなら no-op の冪等な保険。
  if (isShowingPreview(msg, origin)) {
    closePreviewPopover();
    return;
  }
  const proxy = origin === "main" ? mainAnchorProxyRef.value : subAnchorProxyRef.value;
  if (proxy === null) return;
  // proxy は overlay root (= offsetParent) 相対の absolute。bubble の viewport rect を
  // overlay root の rect との差分で overlay 座標系へ変換する
  const overlay = proxy.offsetParent;
  if (overlay === null) return;
  const bubbleRect = anchor.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  anchorRect.value = {
    origin,
    x: bubbleRect.x - overlayRect.x,
    y: bubbleRect.y - overlayRect.y,
    width: bubbleRect.width,
    height: bubbleRect.height,
  };
  // rect の反映は Vue の :style 経由。usePopover は openState の watch で nextTick を跨いで
  // から showPopover するため、表示時点で proxy の位置は確定している
  openPreviewPopover(proxy, { msg, origin });
}

// popover ヘッダの undock ボタン。表示中メッセージを undock 時点のスナップショットとして
// 独立フローティングウィンドウ (UndockedLogLayer) へ切り離す。ウィンドウは repo /
// session 切り替えを跨いで生存するため、タイトルに repo 名 + session タイトルを
// 焼き込んで出自を識別できるようにする。undock 後は popover を閉じる (二重表示を残さない)。
const { undock: undockLog } = useUndockedLog();

// undock 時の実測対象。位置は popover の中間 box の rect、サイズは本文 (スクロール面) の
// rect を in-app パネルへ引き継ぎ、popover がその場でパネル化したような視覚的連続性を出す
// (総サイズでなく中身のサイズを渡す理由は useUndockedLog の doc 参照)。
const previewBoxRef = useTemplateRef<HTMLElement>("previewBox");
const previewBodyRef = useTemplateRef<HTMLElement>("previewBody");

function undockPreview(handoff?: UndockDragHandoff) {
  const ctx = previewContext.value;
  const box = previewBoxRef.value;
  const body = previewBodyRef.value;
  if (ctx === undefined || box === null || body === null) return;
  const rect = box.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  // ヘッダは TerminalLeafTitle と同じ SSOT から組み立てる: repo は dir → findRepoOwning
  // (name + RepoIcon 用 owner)、session タイトルは端末タイトル → セッション一覧のタイトルの
  // 順で sessionDisplayTitle が解決する。sub 由来はどの subagent かも識別できるよう subLabel を
  // 足す (main は自明なので略)。repo 未登録 (起動直後等) は解決できた部分だけで出す。
  const dir = terminalStore.getPaneDir(props.leafId);
  const repo = dir === undefined ? undefined : repoStore.findRepoOwning(dir);
  const sid = sessionId.value;
  const listTitle = sid === undefined ? undefined : repoStore.findSession(sid)?.title;
  const terminalTitle = stripClaudeTitlePrefix(terminalStore.titleByLeafId[props.leafId] ?? "");
  const sessionTitle = sessionDisplayTitle(listTitle, terminalTitle);
  const parts = [sessionTitle];
  if (ctx.origin === "sub") parts.push(subLabel.value);
  const title = parts.filter((p) => p !== undefined && p !== "").join(" · ");
  undockLog(
    {
      speaker: ctx.msg.speaker,
      repoName: repo?.repoName ?? "",
      // undocked window は live な identity 更新を受けない凍結 snapshot のため、
      // 解決中 (undefined) は identicon ("") に倒す。live 消費者と違い `?? ""` を
      // 外してはいけない (外すと解決中に undock した window が恒久的に空白になる)
      repoOwner: repo?.githubIdentity?.owner ?? "",
      title: title === "" ? "Session log" : title,
      text: ctx.msg.text,
      mark: ctx.msg.mark,
      x: rect.left,
      y: rect.top,
      contentWidth: bodyRect.width,
      contentHeight: bodyRect.height,
    },
    handoff,
  );
  closePreviewPopover();
}

/** popover ヘッダのドラッグを undock とみなすしきい値 (px)。undock ボタンのクリックと区別する。 */
const DRAG_UNDOCK_THRESHOLD = 4;

// popover ヘッダのドラッグ検知。しきい値を超えたら undock して、掴んでいる pointer ごと
// UndockedLogWindow へドラッグを引き継ぐ (UndockDragHandoff)。undock は rect を実測してから
// popover を閉じるので、ウィンドウは掴んだその位置に現れてそのまま動かせる。
let headerDrag: { pointerId: number; startX: number; startY: number } | undefined;

function onPreviewHeaderPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const header = event.currentTarget;
  if (!(header instanceof HTMLElement)) return;
  // しきい値到達前に pointer がヘッダ外へ滑っても pointermove を受け続けるため capture する。
  // undock 発火で popover ごと閉じたときの capture は UA が自動解放する。
  header.setPointerCapture(event.pointerId);
  headerDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
}

function onPreviewHeaderPointerMove(event: PointerEvent) {
  if (headerDrag === undefined || event.pointerId !== headerDrag.pointerId) return;
  const dx = event.clientX - headerDrag.startX;
  const dy = event.clientY - headerDrag.startY;
  if (Math.hypot(dx, dy) < DRAG_UNDOCK_THRESHOLD) return;
  const box = previewBoxRef.value;
  if (box === null) return;
  // オフセットは掴んだ瞬間 (pointerdown) の位置基準。しきい値超過時点の位置基準にすると
  // 引き継ぎ直後にしきい値分だけウィンドウが跳ねる。
  const rect = box.getBoundingClientRect();
  const grab = headerDrag;
  headerDrag = undefined;
  undockPreview({
    pointerId: event.pointerId,
    offsetX: grab.startX - rect.left,
    offsetY: grab.startY - rect.top,
  });
}

function onPreviewHeaderPointerUp(event: PointerEvent) {
  if (headerDrag?.pointerId !== event.pointerId) return;
  headerDrag = undefined;
}

// 全文 popover の配置スタイル。popover をタイトルバー帯に食い込ませない。Electron の drag
// region は top layer でも平面で効くため、重なるとヘッダの undock ドラッグが window ドラッグに
// 取られる。
//   - position-area は region を containing block にするがサイズはクランプしないため、inset の
//     keep-out だけでは高さが region を超えると突き抜ける。% は region 高さで解決されるので、
//     max-height を「region − タイトルバー高」にする
//   - main 側の `bottom: var(--titlebar-height)` は base 配置 (下開き・start 整列) では
//     不活性に見えるが、flip-block が block 軸 inset を反転して top keep-out になるため消さない
//   - `-webkit-app-region: no-drag` は keep-out で通常タイトルバーと重ならなくても消さない
//     (min-content が max-height を超える退化幾何で base 配置が overflow する経路の防御)
const previewPopoverStyle = computed(() => {
  const base = {
    position: "fixed",
    maxHeight: "calc(100% - var(--titlebar-height))",
    positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
    "-webkit-app-region": "no-drag",
  } as const;
  if (previewContext.value?.origin === "sub") {
    return {
      ...base,
      positionArea: "block-start span-inline-start",
      top: "var(--titlebar-height)",
    };
  }
  return {
    ...base,
    positionArea: "block-end span-inline-start",
    bottom: "var(--titlebar-height)",
  };
});

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

// 各 overlay は run が 1 つでもあれば出す (run は必ず発言を 1 件以上持つ)。session が無いときは
// events が空なので collectRuns も空配列を返し、副次的にカバーされる。
const hasMain = computed(() => mainRuns.value.length > 0);
const hasSub = computed(() => subRuns.value.length > 0);

// anchor proxy は overlay root (v-if) ごと unmount され得る (session 切替で sessions が
// 一旦空になる等)。anchor を失った popover は UA fallback 位置 (左上) へ飛ぶため、表示中
// origin 側の overlay が消えるときは popover を閉じる。popover の内容は開いた時点の
// session のスナップショットで、overlay 消失後は stale なので閉じるのが意味的にも自然。
// pre-flush watch なので overlay unmount の render より先に hide が走り、左上への一瞬の
// ちらつきも出ない。
watch([hasMain, hasSub], ([main, sub]) => {
  const ctx = previewContext.value;
  if (ctx === undefined) return;
  const overlayAlive = ctx.origin === "main" ? main : sub;
  if (!overlayAlive) closePreviewPopover();
});
</script>

<template>
  <!-- main: 右上。全 run を時系列順に LINE 風吹き出しで並べる -->
  <div
    v-if="hasMain"
    class="pointer-events-none absolute top-1 right-3 z-10 w-56 max-w-[35%] overflow-hidden rounded-md bg-background/70 text-xs/tight"
  >
    <!-- popover の anchor proxy (main)。クリック時点の bubble rect を overlay 相対で写した
         不可視要素。v-for の外にあり unmount されないため、ログ追記で bubble が作り替え
         られても popover は開いた位置に留まり、リサイズには overlay ごと追随する -->
    <div
      ref="mainAnchorProxy"
      aria-hidden="true"
      class="pointer-events-none absolute"
      :style="anchorRect?.origin === 'main' ? anchorProxyStyle : undefined"
    />
    <details :open="mainOpen" @toggle="onMainToggle">
      <summary
        class="pointer-events-auto cursor-pointer truncate bg-element px-2 py-1 text-xs font-semibold text-foreground-low hover:bg-element-hover [&::-webkit-details-marker]:hidden [&::marker]:hidden"
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
        ref="mainScroller"
        class="pointer-events-auto flex max-h-[calc(50cqh-2rem)] flex-col-reverse overflow-y-auto p-2"
      >
        <div class="flex flex-col gap-1">
          <TerminalSessionPreviewRun
            v-for="run in mainRuns"
            :key="run.start"
            :run="run"
            :expanded="isRunExpanded('main', run)"
            :reveal-side="REVEAL_SIDE.main"
            @toggle="toggleRun('main', run, $event)"
            @select="(anchor, msg) => togglePreview(anchor, msg, 'main')"
          />
          <TerminalSessionPreviewProgressDots :count="mainActionCount" />
        </div>
      </div>
    </details>
  </div>

  <!-- sub: 右下。main と同じ LINE 風シーケンス + 同じ max-h スクロール / 折りたたみ構造。
       物理的距離で main との混在を回避する。summary は subagentLabel が組み立てた
       agent 名 / workflow 見出しで、どの subagent の発話なのかを明示する。 -->
  <div
    v-if="hasSub"
    class="pointer-events-none absolute right-3 bottom-1 z-10 w-56 max-w-[35%] overflow-hidden rounded-md bg-background/70 text-xs/tight"
  >
    <!-- popover の anchor proxy (sub)。main 側と同じ規律 -->
    <div
      ref="subAnchorProxy"
      aria-hidden="true"
      class="pointer-events-none absolute"
      :style="anchorRect?.origin === 'sub' ? anchorProxyStyle : undefined"
    />
    <details :open="subOpen" @toggle="onSubToggle">
      <summary
        class="pointer-events-auto cursor-pointer truncate bg-element px-2 py-1 text-xs font-semibold text-foreground-low hover:bg-element-hover [&::-webkit-details-marker]:hidden [&::marker]:hidden"
        :title="subLabel"
      >
        {{ subLabel }}
      </summary>
      <!-- bubble 用の内側コンテナ。details はネイティブの open/close と summary 表示制御だけに
           使い、レイアウト / スクロールは中の div に閉じる。wrapper の構造は main と同じ。 -->
      <div
        ref="subScroller"
        class="pointer-events-auto flex max-h-[calc(50cqh-2rem)] flex-col-reverse overflow-y-auto p-2"
      >
        <div class="flex flex-col gap-1">
          <TerminalSessionPreviewRun
            v-for="run in subRuns"
            :key="run.start"
            :run="run"
            :expanded="isRunExpanded('sub', run)"
            :reveal-side="REVEAL_SIDE.sub"
            @toggle="toggleRun('sub', run, $event)"
            @select="(anchor, msg) => togglePreview(anchor, msg, 'sub')"
          />
          <TerminalSessionPreviewProgressDots :count="subActionCount" />
        </div>
      </div>
    </details>
  </div>

  <!-- 全文 preview popover。anchor は overlay 内の anchor proxy (クリック bubble の rect
       スナップショット)、
       `positionTryFallbacks` で端に押し出されたら反対側へ flip。light-dismiss
       (popover 外 click / ESC) で閉じる。
       本文描画は SessionLogMessageBody に委譲する。
       display は :popover-open のときだけ flex にする。素の flex は UA の
       [popover]:not(:popover-open) { display: none } に勝ち、閉じた popover が描画されたまま
       anchor を失って左上へ飛ぶ。 -->
  <PreviewPopover
    class="m-0 w-3xl max-w-[80vw] flex-col overflow-visible border-none bg-transparent p-0 text-base [&:popover-open]:flex"
    :style="previewPopoverStyle"
  >
    <template v-if="previewContext">
      <!-- 全文 popover はメッセージを読む / コピーする面なので select-text で選択可にする
           (compact な吹き出しプレビューは click-to-expand の chrome なのでデフォルト none のまま)。
           box は flex-col の「ヘッダ + スクロール面」二段構成。undock ボタンをスクロール領域の
           外 (ヘッダ) に出すことで、スクロールバーとの被りを構造的に消す。角丸内への
           painting clip は overflow-hidden が担う。 -->
      <div
        ref="previewBox"
        class="flex max-h-[60vh] min-h-0 flex-col overflow-hidden rounded-md border border-border-strong shadow-xl select-text"
      >
        <!-- ヘッダはドラッグで undock + そのまま移動できる (しきい値超過で発火)。
             undock ボタンは pointerdown.stop でドラッグ判定から外し、クリック undock を残す -->
        <div
          class="flex shrink-0 cursor-grab items-center justify-end border-b border-border bg-panel px-1 py-0.5 select-none"
          title="Drag to undock into floating window"
          @pointerdown="onPreviewHeaderPointerDown"
          @pointermove="onPreviewHeaderPointerMove"
          @pointerup="onPreviewHeaderPointerUp"
          @pointercancel="onPreviewHeaderPointerUp"
        >
          <button
            type="button"
            aria-label="Undock"
            title="Undock into floating window"
            class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
            @pointerdown.stop
            @click="undockPreview()"
          >
            <IconMdiDockWindow class="size-3.5" />
          </button>
        </div>
        <div
          ref="previewBody"
          class="min-h-0 flex-1 overflow-auto"
          :class="SPEAKER_SURFACE_CLASS[previewContext.msg.speaker]"
        >
          <SessionLogMessageBody :text="previewContext.msg.text" :mark="previewContext.msg.mark" />
        </div>
      </div>
    </template>
  </PreviewPopover>
</template>
