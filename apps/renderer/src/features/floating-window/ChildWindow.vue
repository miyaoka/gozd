<script setup lang="ts">
import { CHILD_WINDOW_FRAME_PREFIX, CHILD_WINDOW_TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener, useMutationObserver } from "@vueuse/core";
import { onMounted, onUnmounted, ref } from "vue";
import { useWindowKeyBindings } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import {
  activateChildWindow,
  deactivateChildWindow,
  type ChildWindowHandle,
} from "./childWindowCommands";

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
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** window.open が失敗した。consumer は昇格前の状態へ引き返す。 */
  openFailed: [];
  /** child window が閉じた (ネイティブ close 通過後)。consumer は state を消す。 */
  close: [];
  /** blockClose 中のネイティブ close 要求。consumer が確認フローへ変換する。 */
  closeRequested: [];
  /** childWindow.save コマンド (cmd+s) の要求。保存の可否・実処理は consumer の知識。 */
  saveRequested: [];
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

  // Electron は beforeunload が undefined 以外を返すと close を中止する
  child.onbeforeunload = () => {
    if (!props.blockClose) return undefined;
    emit("closeRequested");
    return false;
  };

  useEventListener(child, "pagehide", () => {
    if (closedBySelf) return;
    emit("close");
  });

  // ==== keybinding 系への接続 ====
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

  // opener の unload (Vite フルリロード / アプリ終了) で child を道連れにする。
  // opener が消える時点で確認フロー (closeRequested の consumer) はもう走れないため、
  // dirty ガードの veto を先に外す — 外さないと dirty な child が close を veto し、
  // 新 renderer から追跡できない孤児ウィンドウとして残る
  useEventListener(window, "pagehide", () => {
    child.onbeforeunload = null;
    child.close();
  });

  targetBody.value = doc.body;
}

onMounted(() => {
  // open 失敗の通知。setup 同期中に emit すると親の v-for 描画中の状態変更になる
  if (child === null) emit("openFailed");
});

onUnmounted(() => {
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
