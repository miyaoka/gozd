<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 横3カラム: SidebarPane → 中央カラム → NavigatorPane
- 中央カラム: Terminal（上、flex-1）→ GitGraphPane（下、固定高さ）の上下分割
- NavigatorPane: Filer（上）+ Changes（下）の上下分割
- Preview は Popover API でトップレイヤーに配置し、レイアウトフローから分離。中央カラムの
  右端に右端を揃えて左側へ展開する（開閉は `preview.toggle`（Cmd+J / コマンドパレット）で、
  常設の開閉ボタンは持たない）

## リサイズ

幅・高さの ref はユーザーがドラッグで決めた**希望値**で、描画にはウィンドウサイズへ収めた
派生値（`layoutSizes.ts`）を使う。縮小のたびに ref を書き戻すと希望値が失われ、ウィンドウを
戻しても元のレイアウトに復元できない。ドラッグの起点も描画値（DOM 実測 / 派生値）で取る。

各ハンドルが希望値を書き換えるのは隣接する左右（上下）のペインだけ。ただし描画値は
ウィンドウサイズの予算からの派生なので、他のペインが希望値より圧縮されている状態では
空いた分がそちらの復元に回る。この状態ではドラッグ量と境界の移動量は一致しない。

### Preview popover の被覆境界

トップレイヤーの要素は通常フローの `z-index` を無条件に上回り、覆われたリサイズハンドルは
pointer event が届かず操作不能になる。Preview は Terminal と Navigator の境界に右端を接する
常駐面なので、**覆われたハンドルが見えているのに反応しない**死角ができる。これを防ぐため、
Preview popover は列の境界にあるハンドルを覆わない。

- popover の右端はアンカー（中央カラム）の右端に揃う。Navigator のハンドルは中央カラムの外
  （兄弟要素）に位置するため被覆範囲に入らない
- popover の左端が Sidebar のハンドルを越えないよう、描画幅を「中央カラム幅 − Terminal
  最小幅」で切る（`fitPreviewWidth`）。ここで下限による押し戻しをすると幾何的に入らない幅が
  描画へ流れ、ハンドルを覆う
- 表示中は中央カラムに Preview の取り分を予約し、列幅（描画値）を譲らせる。予約しないと
  上の上限が 0 まで下がり、見えない面へフォーカスだけが移る状態を作れてしまう

この契約は Preview に限る。中央カラム**内側**のハンドル（GitGraph の上下分割 / Terminal の
分割）は被覆範囲にあり、Preview 表示中は位置次第で掴めない。右ドックの transient パネル
（server / event log / notification center）はいずれも `right: 0` の全高 popover で Navigator を
丸ごと覆うため、表示中は列の境界ハンドルも掴めない。これらは不透明なパネルが乗っていること
自体が視認できる短命サーフェスなので、死角にはならない。
</doc>

<script setup lang="ts">
import { useWindowSize } from "@vueuse/core";
import { computed, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useCommandRegistry, useContextKeys } from "../../shared/command";
import { useRepoStore } from "../../shared/repo";
import { closeFocusedSurface, hasFocusedSurface, useSurface } from "../../shared/surface";
import { ResizeHandle } from "../../shared/ui";
import { DashboardDialog, registerDashboardCommand } from "../dashboard";
import { registerFilerCommands } from "../filer";
import { GitGraphPane } from "../git-graph";
import { NavigatorPane } from "../navigator";
import {
  CommandPalette,
  FilePickerDialog,
  IssuePickerDialog,
  PrPickerDialog,
  QuickPick,
  registerFilePickerCommand,
  registerIssueCommand,
  registerPrCommand,
  registerReviveCommand,
  RevivePickerDialog,
} from "../palette";
import {
  BlamePopover,
  FileHistoryPopover,
  PreviewPane,
  registerMarkdownHistoryCommands,
  UnsavedDraftConfirmDialog,
  usePreviewEditStore,
  usePreviewStore,
  useUnsavedDraftConfirm,
} from "../preview";
import { registerSearchCommand, SearchDialog } from "../search";
import { registerAppConfigSync, registerSettingsCommand, SettingsModal } from "../settings";
import { SidebarPane } from "../sidebar";
import { registerThemeCommand, TerminalPane } from "../terminal";
import {
  centerColumnWidth,
  fitColumnWidths,
  fitGitGraphHeight,
  fitPreviewWidth,
  GIT_GRAPH_MIN_HEIGHT,
  NAVIGATOR_MIN_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewBeforeMinWidth,
  SIDEBAR_MIN_WIDTH,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
} from "./layoutSizes";
import NotificationCenterPanel from "./NotificationCenterPanel.vue";
import NotificationToast from "./NotificationToast.vue";
import { rpcWindowClose } from "./rpc";
import TitleBar from "./TitleBar.vue";

const repoStore = useRepoStore();
const previewStore = usePreviewStore();
const previewEditStore = usePreviewEditStore();
// main window に出す破棄確認の shared instance (undock child window は per-window instance)
const mainDraftConfirm = useUnsavedDraftConfirm();
const contextKeys = useContextKeys();
const previewPopoverRef = useTemplateRef<HTMLElement>("previewPopover");

// レイアウト・ウィンドウスコープのコマンド登録
const { register } = useCommandRegistry();
const disposePreviewToggle = register("preview.toggle", {
  label: "Preview: Toggle",
  keybinding: { key: "cmd+j" },
  handler: () => {
    previewStore.toggle();
    return true;
  },
});
// 閉じる対象はフォーカスが決める (shared/surface)。サーフェスの種類ごとに when を書き分けず、
// 「サーフェス内にフォーカスがある」1 条件で受ける。ESC と Cmd+W は同義なので同じコマンドに
// 2 つのキーを割り当てる。child window は別 OS ウィンドウで自前の close を持つため除外する。
watch(hasFocusedSurface, (has) => contextKeys.set("surfaceFocused", has), { immediate: true });
// label を持たない (keybinding 専用)。precondition がフォーカスなので、パレットを開いた時点で
// フォーカスが dialog へ移り条件が偽になる = 原理的にパレットから起動できない
const disposeSurfaceClose = register("surface.closeFocused", {
  precondition: "surfaceFocused",
  keybinding: { key: ["cmd+w", "escape"], when: "!childWindowFocused" },
  handler: () => closeFocusedSurface(),
});
const disposeWindowClose = register("window.close", {
  label: "Window: Close",
  keybinding: { key: "shift+cmd+w", when: "!childWindowFocused" },
  handler: () => {
    void rpcWindowClose();
    return true;
  },
});
const disposeThemeCommand = registerThemeCommand();
const disposeSettingsCommand = registerSettingsCommand();
const disposeAppConfigSync = registerAppConfigSync();
const disposePrCommand = registerPrCommand();
const disposeIssueCommand = registerIssueCommand();
const disposeFilePickerCommand = registerFilePickerCommand();
const disposeSearchCommand = registerSearchCommand();
const disposeReviveCommand = registerReviveCommand();
const disposeDashboardCommand = registerDashboardCommand();
const disposeMarkdownHistoryCommands = registerMarkdownHistoryCommands();
const disposeFilerCommands = registerFilerCommands();
onUnmounted(disposePreviewToggle);
onUnmounted(disposeSurfaceClose);
onUnmounted(disposeWindowClose);
onUnmounted(disposeThemeCommand);
onUnmounted(disposeSettingsCommand);
onUnmounted(disposeAppConfigSync);
onUnmounted(disposePrCommand);
onUnmounted(disposeIssueCommand);
onUnmounted(disposeFilePickerCommand);
onUnmounted(disposeSearchCommand);
onUnmounted(disposeReviveCommand);
onUnmounted(disposeDashboardCommand);
onUnmounted(disposeMarkdownHistoryCommands);
onUnmounted(disposeFilerCommands);

const { width: windowWidth, height: windowHeight } = useWindowSize();
const centerTerminalRef = useTemplateRef<HTMLElement>("centerTerminal");

// ref はユーザーがドラッグで決めた「希望サイズ」、描画は下の computed（ウィンドウサイズに
// 収めた派生値）を使う。縮小のたびに ref を書き戻すと希望サイズが失われ、ウィンドウを
// 戻しても復元できない
const desiredSidebarWidth = ref(260);
const desiredNavigatorWidth = ref(256);
const desiredPreviewWidth = ref(1200);
const desiredGitGraphHeight = ref(128);

/**
 * 中央カラムに残す幅。Preview 表示中は Preview の取り分も予約する。
 * 予約しないと列幅が Terminal 最小幅まで詰められた時点で Preview の描画幅が 0 になり、
 * 見えない面へフォーカスだけが移る。
 *
 * 列ハンドルの中央カラム側 min もこの値を使う。ドラッグ側が予約より小さい min を持つと、
 * 描画が予約で頭打ちのまま希望幅だけが増え、Preview を閉じた瞬間に列幅が飛ぶ。
 */
const reservedCenterWidth = computed(
  () => TERMINAL_MIN_WIDTH + (previewStore.isOpen ? PREVIEW_MIN_WIDTH : 0),
);

const columnWidths = computed(() =>
  fitColumnWidths(
    windowWidth.value,
    { sidebar: desiredSidebarWidth.value, navigator: desiredNavigatorWidth.value },
    reservedCenterWidth.value,
  ),
);
const sidebarWidth = computed(() => columnWidths.value.sidebar);
const navigatorWidth = computed(() => columnWidths.value.navigator);
const terminalWidth = computed(() => centerColumnWidth(windowWidth.value, columnWidths.value));
const previewWidth = computed(() =>
  fitPreviewWidth(desiredPreviewWidth.value, terminalWidth.value),
);
const gitGraphHeight = computed(() =>
  fitGitGraphHeight(desiredGitGraphHeight.value, windowHeight.value),
);

/** ドラッグ開始時の描画幅（希望幅ではなく、いまユーザーが見ている幅を起点にする） */
const getSidebarWidth = () => sidebarWidth.value;
const getNavigatorWidth = () => navigatorWidth.value;
const getTerminalWidth = () => terminalWidth.value;

/** popover の左に必ず残す幅。これ以上左へ伸びると Sidebar のハンドルを覆う */
const previewBeforeMinSize = computed(() => previewBeforeMinWidth(sidebarWidth.value));

/**
 * ドラッグ開始時の popover 幾何は DOM 実測を SSOT にする（位置は CSS の
 * `right: anchor(right)` が決めるため、JS 側で再導出すると二重管理になる）。
 * popover 非表示中は 0 を返し、clampResizeDelta が空区間として drag を no-op にする。
 */
const getPreviewBeforeSize = () => previewPopoverRef.value?.getBoundingClientRect().left ?? 0;
const getPreviewAfterSize = () => previewPopoverRef.value?.getBoundingClientRect().width ?? 0;

// previewVisible context key を store の isOpen と同期
watch(
  () => previewStore.isOpen,
  (open) => {
    contextKeys.set("previewVisible", open);
  },
  { immediate: true },
);

/**
 * previewEditable context key を「編集セッションの有無」と同期。
 * preview.save の Cmd+S は DOM フォーカス (inputFocused) ではなくこの論理状態で判定する。
 * VSCode の `workbench.action.files.save` も `when: undefined` (フォーカス位置を問わず
 * "アクティブなドキュメントを保存する") であり、「今アクティブな編集対象があるか」の
 * 論理条件の方が正しいスコープになる。inputFocused ベースにすると、Monaco 自身も
 * 隠し textarea で入力を受けるため「Monaco 編集中こそ Cmd+S を使いたい」場面まで巻き込んで
 * 無効化してしまう (Monaco の Cmd+[ / Cmd+] 等、他の !inputFocused binding も同様の理由で
 * inputFocused の意味を変えるべきではない)。
 */
watch(
  () => previewEditStore.hasSession,
  (hasSession) => {
    contextKeys.set("previewEditable", hasSession);
  },
  { immediate: true },
);

/** 中央カラム内 Terminal の DOM 実測高さ（flex-1 のため v-model 不可） */
function getCenterTerminalHeight(): number {
  return centerTerminalRef.value?.offsetHeight ?? TERMINAL_MIN_HEIGHT;
}

/** ドラッグ開始時の描画高さ */
const getGitGraphHeight = () => gitGraphHeight.value;

const { raise } = useSurface(previewPopoverRef, {
  isOpen: () => previewStore.isOpen,
  requestClose: () => previewStore.requestClose(),
  // 既に開いている preview へ別の中身を出す経路 (reveal / summary 進入) を前面化として受ける
  raiseSignal: () => previewStore.openEpoch,
});
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-background text-foreground">
    <TitleBar />
    <!-- 横3カラム: Sidebar | Center(Terminal + GitGraph) | Navigator -->
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div class="shrink-0 overflow-hidden" :style="{ width: `${sidebarWidth}px` }">
        <SidebarPane />
      </div>
      <ResizeHandle
        v-model:before-size="desiredSidebarWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH"
        :after-min-size="reservedCenterWidth"
        :get-before-size="getSidebarWidth"
        :get-after-size="getTerminalWidth"
      />

      <!-- 中央カラム: Terminal（上）+ GitGraph（下）。Preview popover のアンカー -->
      <div class="_preview-anchor flex min-w-0 flex-1 flex-col overflow-hidden">
        <div ref="centerTerminal" class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TerminalPane :min-width="TERMINAL_MIN_WIDTH" />
        </div>

        <template v-if="repoStore.selectedIsGitRepo">
          <ResizeHandle
            v-model:after-size="desiredGitGraphHeight"
            direction="vertical"
            :before-min-size="TERMINAL_MIN_HEIGHT"
            :after-min-size="GIT_GRAPH_MIN_HEIGHT"
            :get-before-size="getCenterTerminalHeight"
            :get-after-size="getGitGraphHeight"
          />
          <div class="shrink-0 overflow-hidden" :style="{ height: `${gitGraphHeight}px` }">
            <GitGraphPane />
          </div>
        </template>
      </div>

      <!-- このハンドルを中央カラム内へ移すと Preview 表示中は popover に覆われて掴めない -->
      <ResizeHandle
        v-model:after-size="desiredNavigatorWidth"
        direction="horizontal"
        :before-min-size="reservedCenterWidth"
        :after-min-size="NAVIGATOR_MIN_WIDTH"
        :get-before-size="getTerminalWidth"
        :get-after-size="getNavigatorWidth"
      />

      <div class="shrink-0 overflow-hidden" :style="{ width: `${navigatorWidth}px` }">
        <NavigatorPane />
      </div>
    </div>

    <!-- tabindex="-1" は前面化時のフォーカス追従の行き先 (shared/surface)。
         tab 到達不能なパネル面へのフォーカスルーティングなので focus ring は出さない -->
    <div
      ref="previewPopover"
      popover="manual"
      tabindex="-1"
      class="_preview-popover overflow-hidden border-0 border-l border-border bg-background p-0 outline-hidden [&:popover-open]:flex"
      :style="{ width: `${previewWidth}px` }"
      @pointerdown.capture="raise()"
    >
      <!-- 左端リサイズハンドル -->
      <ResizeHandle
        v-model:after-size="desiredPreviewWidth"
        direction="horizontal"
        :before-min-size="previewBeforeMinSize"
        :after-min-size="PREVIEW_MIN_WIDTH"
        :get-before-size="getPreviewBeforeSize"
        :get-after-size="getPreviewAfterSize"
      />

      <div class="min-w-0 flex-1 overflow-hidden">
        <PreviewPane @close="previewStore.requestClose()" />
      </div>
    </div>

    <CommandPalette />
    <QuickPick />
    <SearchDialog />
    <FilePickerDialog />
    <PrPickerDialog />
    <IssuePickerDialog />
    <RevivePickerDialog />
    <DashboardDialog />
    <SettingsModal />
    <BlamePopover />
    <FileHistoryPopover />
    <UnsavedDraftConfirmDialog :confirm="mainDraftConfirm" />
    <NotificationToast />
    <NotificationCenterPanel />
  </div>
</template>

<style>
._preview-anchor {
  anchor-name: --preview-anchor;
}

._preview-popover {
  /* top-layer の popover はタイトルバーを覆ってドラッグ領域を塞ぐため下端に逃がす */
  position-anchor: --preview-anchor;
  inset: unset;
  margin: 0;
  top: var(--titlebar-height);
  bottom: 0;
  right: anchor(right);
  /* UA スタイル [popover] { height: fit-content } を打ち消す。
     height が auto でないと top + bottom の伸縮が効かずコンテンツ高さに縮む */
  height: auto;
  max-height: none;
}
</style>
