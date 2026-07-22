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
  追従させる (pointer と child の間に offset を保つ算術は in-app FloatingWindow のドラッグと
  同型で、座標系だけ viewport → screen になる)
- 追従は script が開いた popup に許可されている `moveTo()` で行う。`moveTo()` は現在の
  ディスプレイ内にクランプされる (Chromium の popup 逃亡対策) ため、ドラッグ追従で
  ディスプレイは跨げない (既知の制限)。クランプ解除の代替は両方実測済みで不採用:
  Window Management permission 経路 (`getScreenDetails()`) は Electron の browser 層が
  実装しておらず効かない。main の `setPosition` へ RPC で流すとクランプは消えるが、
  macOS のウィンドウ帰属 (過半のディスプレイの Space に属す) の切り替えと座標変換の
  基準フリップが押し合い、境界付近で発振する。跨ぎたい場合はネイティブ titlebar ドラッグ
  (window server の特別扱いで跨げる) を使う
- `window.open` の frame 名は乱数で一意化する。main が did-create-window の
  `details.frameName` で BrowserWindow を registry に確保し、main window 向け一括操作
  (setTitleContext) から child を除外する判定に使う
</doc>

<script setup lang="ts">
import { CHILD_WINDOW_FRAME_PREFIX } from "@gozd/shared";
import { useEventListener, useMutationObserver } from "@vueuse/core";
import { onMounted, onUnmounted, ref } from "vue";
import { useWindowKeyBindings } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import {
  activateChildWindow,
  deactivateChildWindow,
  type ChildWindowHandle,
} from "./childWindowCommands";
import type { UndockDragHandoff } from "./useFloatingWindows";

interface Props {
  /** child window のタイトルバー表示 (document.title)。 */
  title: string;
  /** 生成時のスクリーン座標とコンテンツサイズ (window.open features)。以後の SSOT は OS。 */
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  /** true の間、ネイティブ close を veto して closeRequested を emit する (dirty ガード用)。 */
  blockClose: boolean;
  /** undock 元から引き継いだドラッグ (moveTo 追従。doc 参照)。offset はコンテンツ原点基準。 */
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
}>();

const notification = useNotificationStore();

/** Teleport 先 (child の body)。open 失敗時は undefined のまま本文を描画しない。 */
const targetBody = ref<HTMLElement>();

// popup=yes が無いと通常タブ扱いになり得るため明示する (VS Code auxiliary window と同じ)
const features = [
  "popup=yes",
  `width=${Math.round(props.width)}`,
  `height=${Math.round(props.height)}`,
  `left=${Math.round(props.screenX)}`,
  `top=${Math.round(props.screenY)}`,
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
    // moveTo の座標は window 外枠原点。offset はコンテンツ原点基準なので、titlebar 等の
    // chrome 高 (outer/inner 差) を差し引いて外枠原点へ換算する
    const chromeY = child.outerHeight - child.innerHeight;
    child.moveTo(
      Math.round(event.screenX - dragState.offsetX),
      Math.round(event.screenY - dragState.offsetY - chromeY),
    );
  });
  const endDrag = (event: PointerEvent) => {
    if (dragState?.pointerId !== event.pointerId) return;
    dragState = undefined;
  };
  useEventListener(window, "pointerup", endDrag);
  useEventListener(window, "pointercancel", endDrag);

  // 初期配置の content 揃え。window.open の top は外枠原点に効くため、child 自身の
  // chrome 高 (標準 titlebar) の分だけコンテンツが要求位置より下にずれる。chrome 高は
  // open 前には測れないので、open 後の初回フレームで実測して 1 回だけ補正する。
  // ドラッグ引き継ぎ中は pointermove の moveTo が同じ content 揃えを毎回行うため補正
  // しない (補正すると古い初期座標へ巻き戻る)
  child.requestAnimationFrame(() => {
    if (dragState !== undefined) return;
    const chromeY = child.outerHeight - child.innerHeight;
    if (chromeY <= 0) return;
    child.moveTo(Math.round(props.screenX), Math.round(props.screenY - chromeY));
  });

  targetBody.value = doc.body;
}

onMounted(() => {
  // open 失敗の close 通知。setup 同期中に emit すると親の v-for 描画中の状態変更になる
  if (child === null) emit("close");
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
