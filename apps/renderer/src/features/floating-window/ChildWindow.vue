<doc lang="md">
undock されたコンテンツ 1 件を別 OS ウィンドウ (Electron child window) として描く汎用シェル。

`window.open("about:blank")` は same-origin のため opener と同一 renderer プロセスに作られ、
slot の中身は本体の Pinia store / RPC bridge / module singleton をそのまま参照できる
(VS Code の auxiliary window と同型)。main 側 `installExternalLinkPolicy` の
setWindowOpenHandler が about:blank だけを allow する契約とセット。

- スタイルは opener の head から style / link[rel=stylesheet] を複製し、head の
  MutationObserver で追加・削除・書き換え (Vite HMR の style 注入) のたびに全再複製する。
  枚数は高々数枚のため差分同期にしない
- about:blank は base URL を持たないため、opener の URL を `<base href>` に張る。これが
  無いと複製 CSS や slot 内 `<img>` の相対 / ルート相対参照が全て解決不能になる
- 本文 slot は Teleport で child の body 直下へ投影する。slot 内のコードが暗黙の
  `window` / `document` グローバルを参照すると opener 側を掴む (element 直付けの
  listener は child 内でもそのまま動く)
- close は 2 経路: ユーザーのネイティブ close (traffic light) は `blockClose` が false なら
  そのまま閉じて pagehide → close emit (consumer が state を消す)、true なら beforeunload
  の veto (Electron は undefined 以外の返却で close を中止する) で止めて closeRequested を
  emit する。確認ダイアログ等は consumer が opener 側で出し、通過したら state を消す。
  state 消滅による unmount 時はシェルが window を閉じる
- キー入力は shared/command の keybinding 系に一元化する: `useWindowKeyBindings(child)` で
  child の document にも同一 dispatcher の keydown を張り、child 固有の割り当て
  (cmd+w close / cmd+s save) は `childWindowFocused` context key の when 条件で解決する
  (VS Code の onDidRegisterWindow + 単一 resolver と同じ構造)。OS の focus / blur を
  childWindowCommands の activate / deactivate に変換し、コマンドの対象 (フォーカス中の
  child) と context key を同時に更新する。close はネイティブ close と同じ経路
  (blockClose の veto / 確認)、save は saveRequested emit で consumer に委ねる
- opener の unload (Vite フルリロード / アプリ終了) は child を道連れに閉じる。opener の
  renderer プロセスが死ぬと child の JS ごと消えるため蘇生はなく、undock ウィンドウは
  揮発的 (位置・サイズ含め永続化しない) という契約で受容する
- `handoff` があれば undock 元のドラッグを OS ウィンドウの移動として継続する。ネイティブの
  window drag をプログラムから開始する API は無いが、掴んだままの pointer の capture は
  opener 側 window に残り続けるため、opener の pointermove をウィンドウ移動へ変換して
  追従させる (pointer と child の間の offset をスクリーン座標で保つ)
- 追従は main の `setPosition` へ RPC で流す (`/childWindow/move`。位置のみ書き高さに
  触れない)。renderer の `moveTo` / `resizeBy` は使わない — Blink がキャッシュした高さ込みの
  full rect を SetBounds へ送るため、初回レイアウト前 (inner=0) や mount 時の header resize と
  並走するドラッグで高さを破壊する (bounds ログの実測で確認)。`moveTo` にあった
  ディスプレイ内クランプ (Chromium の popup 逃亡対策) は setPosition には無い。過去の検討では
  setPosition 追従に macOS のウィンドウ帰属切替との押し合いで境界発振の観測があり、
  ディスプレイ境界跨ぎの挙動は要実機確認 (発振する場合はネイティブ titlebar ドラッグが代替)
- `window.open` の frame 名は乱数で一意化する。main が did-create-window の
  `details.frameName` で BrowserWindow を registry に確保し、main window 向け一括操作
  (setTitleContext) から child を除外する判定に使う
</doc>

<script setup lang="ts">
import { CHILD_WINDOW_FRAME_PREFIX, CHILD_WINDOW_TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener, useMutationObserver } from "@vueuse/core";
import { onMounted, onUnmounted, ref } from "vue";
import { useWindowKeyBindings } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import {
  activateChildWindow,
  deactivateChildWindow,
  type ChildWindowHandle,
} from "./childWindowCommands";
import { type ChildWindowShownPayload, rpcChildWindowMove } from "./rpc";
import type { UndockDragHandoff } from "./useChildWindows";

interface Props {
  /** child window のタイトルバー表示 (document.title)。 */
  title: string;
  /** 生成時のコンテンツ原点スクリーン座標とコンテンツサイズ。features は外枠に効くため、
   * height には titlebar 分 (CHILD_WINDOW_TITLEBAR_HEIGHT) を足して渡す。以後の SSOT は OS。 */
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  /** true の間、ネイティブ close を veto して closeRequested を emit する (dirty ガード用)。 */
  blockClose: boolean;
  /** undock 元から引き継いだドラッグ (main setPosition の RPC 追従。doc 参照)。offset は
   * コンテンツ原点基準。 */
  handoff?: UndockDragHandoff;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** child window が閉じた (ネイティブ close 通過後)。consumer は state を消す。 */
  close: [];
  /** blockClose 中のネイティブ close 要求。consumer が確認フローへ変換する。 */
  closeRequested: [];
  /** childWindow.save コマンド (cmd+s) の要求。保存の可否・実処理は consumer の知識。 */
  saveRequested: [];
  /** open 成功。frameName は main 側 registry のキーで、consumer が bounds 操作 RPC
   * (rpcChildWindowResizeBy 等) の対象指定に使う。 */
  opened: [frameName: string];
  /** OS の表示完了 (main が show event を childWindowShown push で転送)。consumer は
   * undock 元の後始末 (ゴースト解除 / popover close) の合図に使う。push が落ちた場合は
   * 発火しないため、consumer 側は timeout の保険を併用する。 */
  shown: [];
}>();

const notification = useNotificationStore();

/** Teleport 先 (child の body)。open 失敗時は undefined のまま本文を描画しない。 */
const targetBody = ref<HTMLElement>();

// popup=yes が無いと通常タブ扱いになり得るため明示する (VS Code auxiliary window と同じ)。
// features の height / top は外枠基準で解釈されるため、titlebar 分をここで換算して
// コンテンツの rect が props の要求どおりになるよう焼き込む。open 後に moveTo / resizeTo で
// 補正しないのは、それらが Blink の把握している rect を丸ごと SetBounds に送るため —
// 複数の補正が別タイミングで走ると、後発が古いサイズ / 位置込みの rect で先発の変更を
// 巻き戻す (consumer の mount 時 resize と競合し、タイミング依存の不具合になる)
const features = [
  "popup=yes",
  // show=no で非表示のまま生成し、初回描画完了 (ready-to-show) 後に main が show() する
  // (Electron 公式の flash 回避策。main.ts の did-create-window 参照)。native 背景色は
  // main が overrideBrowserWindowOptions で与える (WINDOW_BACKGROUND_COLOR)
  "show=no",
  `width=${Math.round(props.width)}`,
  `height=${Math.round(props.height) + CHILD_WINDOW_TITLEBAR_HEIGHT}`,
  `left=${Math.round(props.screenX)}`,
  `top=${Math.round(props.screenY) - CHILD_WINDOW_TITLEBAR_HEIGHT}`,
].join(",");
// frame 名は main 側の allow 判定 / registry の対象解決キー (prefix は @gozd/shared が SSOT)。
// 同名 window があると window.open が新規生成せず既存を返してしまうため、乱数で一意化する
// (HMR でカウンタが巻き戻る事故も避ける)
const frameName = `${CHILD_WINDOW_FRAME_PREFIX}${crypto.randomUUID()}`;
const child = window.open("about:blank", frameName, features);

/** unmount 経路の close をユーザー起点の pagehide と区別するフラグ。 */
let closedBySelf = false;

/** keybinding コマンドの対象ハンドル。open 成功時のみ設定 (unmount の deactivate 用に巻き上げ)。 */
let handle: ChildWindowHandle | undefined;

/** childWindowShown push の購読解除。open 成功時のみ設定 (unmount 用に巻き上げ)。 */
let unsubscribeShown: (() => void) | undefined;

if (child === null) {
  // fallback しない: 開けない (main 側 policy 不整合等) は通知して即 close に倒す
  notification.error("Failed to open undocked window");
} else {
  const doc = child.document;
  doc.title = props.title;

  // <base> を最初に張る (以降に複製する CSS の相対参照が解決できるように)
  const base = doc.createElement("base");
  base.href = window.location.href;
  doc.head.appendChild(base);
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "UTF-8");
  doc.head.appendChild(charset);

  let styleClones: Element[] = [];
  const syncStyles = () => {
    for (const clone of styleClones) clone.remove();
    styleClones = [];
    for (const node of document.head.querySelectorAll("style, link[rel='stylesheet']")) {
      const clone = node.cloneNode(true) as Element;
      doc.head.appendChild(clone);
      styleClones.push(clone);
    }
  };
  syncStyles();
  // characterData は Vite HMR が既存 <style> のテキストを書き換える経路のため
  useMutationObserver(document.head, syncStyles, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Electron は beforeunload が undefined 以外を返すと close を中止する (doc 参照)
  child.onbeforeunload = () => {
    if (!props.blockClose) return undefined;
    emit("closeRequested");
    return false;
  };

  useEventListener(child, "pagehide", () => {
    if (closedBySelf) return;
    emit("close");
  });

  // ==== keybinding 系への接続 (doc 参照) ====
  useWindowKeyBindings(child);
  const ownHandle: ChildWindowHandle = {
    // ネイティブ close と同じ経路: blockClose 中は veto 相当で確認フローへ
    requestClose: () => {
      if (props.blockClose) {
        emit("closeRequested");
        return;
      }
      child.close();
    },
    requestSave: () => emit("saveRequested"),
  };
  handle = ownHandle;
  // window.open 直後は child がフォーカスを持つが focus event は既に済んでいることがある
  // ため、生成時に activate してから focus / blur で追従する
  activateChildWindow(ownHandle);
  useEventListener(child, "focus", () => activateChildWindow(ownHandle));
  useEventListener(child, "blur", () => deactivateChildWindow(ownHandle));

  // opener の unload (Vite フルリロード / アプリ終了) で child を道連れにする (doc 参照)。
  // opener が消える時点で確認フロー (closeRequested の consumer) はもう走れないため、
  // dirty ガードの veto を先に外す — 外さないと dirty な child が close を veto し、
  // 新 renderer から追跡できない孤児ウィンドウとして残る
  useEventListener(window, "pagehide", () => {
    child.onbeforeunload = null;
    child.close();
  });

  // ==== drag handoff: opener に残った pointer capture をウィンドウ移動へ変換する (doc 参照) ====
  let dragState = props.handoff;
  useEventListener(window, "pointermove", (event: PointerEvent) => {
    if (dragState === undefined || event.pointerId !== dragState.pointerId) return;
    // 位置は main の setPosition (位置のみ書く) で更新する。renderer の moveTo は Blink
    // キャッシュの高さ込み full rect を SetBounds に送るため、mount 時の header resize と
    // 並走するドラッグで高さを破壊する (bounds 検証ログで確認済み)。座標は window 外枠
    // 原点。offset はコンテンツ原点基準なので titlebar 分を差し引いて換算する
    void rpcChildWindowMove({
      frameName,
      x: Math.round(event.screenX - dragState.offsetX),
      y: Math.round(event.screenY - dragState.offsetY - CHILD_WINDOW_TITLEBAR_HEIGHT),
    });
  });
  const endDrag = (event: PointerEvent) => {
    if (dragState?.pointerId !== event.pointerId) return;
    dragState = undefined;
  };
  useEventListener(window, "pointerup", endDrag);
  useEventListener(window, "pointercancel", endDrag);

  targetBody.value = doc.body;
  emit("opened", frameName);

  // 表示完了 push を自 frameName で filter して shown emit に変換する (emits の doc 参照)
  unsubscribeShown = onMessage<ChildWindowShownPayload>("childWindowShown", (payload) => {
    if (payload.frameName !== frameName) return;
    emit("shown");
  });
}

onMounted(() => {
  // open 失敗の close 通知。setup 同期中に emit すると親の v-for 描画中の状態変更になる
  if (child === null) emit("close");
});

onUnmounted(() => {
  unsubscribeShown?.();
  if (child === null) return;
  closedBySelf = true;
  // フォーカスされたまま閉じると blur が飛ばないことがあるため、unmount で確実に解除する
  if (handle !== undefined) deactivateChildWindow(handle);
  // 自発 close は veto を通さない (ガード判断は consumer が state を消す前に済んでいる)
  child.onbeforeunload = null;
  if (!child.closed) child.close();
});
</script>

<template>
  <Teleport v-if="targetBody !== undefined" :to="targetBody">
    <slot />
  </Teleport>
</template>
