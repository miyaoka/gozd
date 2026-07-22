<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 横3カラム: SidebarPane → 中央カラム → Preview 開閉ボタン → NavigatorPane（各ペイン間にリサイズハンドル）
- 中央カラム: Terminal（上、flex-1）→ GitGraphPane（下、固定高さ）の上下分割
- NavigatorPane: Filer（上）+ Changes（下）の上下分割
- Preview は Popover API でトップレイヤーに配置し、レイアウトフローから分離。Navigator の左側に表示

## リサイズ

各ハンドルは隣接する左右（上下）のペインだけを連動してリサイズする。
ハンドルより遠いペインには影響しない。
</doc>

<script setup lang="ts">
import { TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener, useWindowSize } from "@vueuse/core";
import { computed, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useCommandRegistry, useContextKeys } from "../../shared/command";
import { useRepoStore } from "../../shared/repo";
import { registerFilerCommands } from "../filer";
import { closeFrontFloatingWindow, hasFloatingWindow } from "../floating-window";
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
} from "../preview";
import { registerAppConfigSync, registerSettingsCommand, SettingsModal } from "../settings";
import { SidebarPane } from "../sidebar";
import { registerThemeCommand, TerminalPane } from "../terminal";
import { useWorktreeStore } from "../worktree";
import NotificationCenterPanel from "./NotificationCenterPanel.vue";
import NotificationToast from "./NotificationToast.vue";
import ResizeHandle from "./ResizeHandle.vue";
import { rpcWindowClose } from "./rpc";
import TitleBar from "./TitleBar.vue";
import IconLucidePanelRightOpen from "~icons/lucide/panel-right-open";

const repoStore = useRepoStore();
const worktreeStore = useWorktreeStore();
const previewStore = usePreviewStore();
const previewEditStore = usePreviewEditStore();
const contextKeys = useContextKeys();
const previewPopoverRef = useTemplateRef<HTMLElement>("previewPopover");

// レイアウト・ウィンドウスコープのコマンド登録
const { register } = useCommandRegistry();
const disposePreviewToggle = register("preview.toggle", {
  label: "Preview: Toggle",
  handler: () => {
    previewStore.toggle();
    return true;
  },
});
const disposePreviewClose = register("preview.close", {
  label: "Preview: Close",
  handler: () => {
    if (!previewStore.isOpen) return false;
    previewStore.requestClose();
    return true;
  },
});
const disposeFloatingWindowClose = register("floatingWindow.closeFront", {
  label: "Floating Window: Close Front",
  handler: () => closeFrontFloatingWindow(),
});
const disposeWindowClose = register("window.close", {
  label: "Window: Close",
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
const disposeReviveCommand = registerReviveCommand();
const disposeMarkdownHistoryCommands = registerMarkdownHistoryCommands();
const disposeFilerCommands = registerFilerCommands();
onUnmounted(disposePreviewToggle);
onUnmounted(disposePreviewClose);
onUnmounted(disposeFloatingWindowClose);
onUnmounted(disposeWindowClose);
onUnmounted(disposeThemeCommand);
onUnmounted(disposeSettingsCommand);
onUnmounted(disposeAppConfigSync);
onUnmounted(disposePrCommand);
onUnmounted(disposeIssueCommand);
onUnmounted(disposeFilePickerCommand);
onUnmounted(disposeReviveCommand);
onUnmounted(disposeMarkdownHistoryCommands);
onUnmounted(disposeFilerCommands);

/** ハンドル幅 w-2 = 8px */
const HANDLE_WIDTH = 8;

const SIDEBAR_MIN_WIDTH = 120;
const PREVIEW_MIN_WIDTH = 200;
const TERMINAL_MIN_WIDTH = 200;
const NAVIGATOR_MIN_WIDTH = 180;
const GIT_GRAPH_MIN_HEIGHT = 40;
const TERMINAL_MIN_HEIGHT = 150;

const { width: windowWidth, height: windowHeight } = useWindowSize();
const centerTerminalRef = useTemplateRef<HTMLElement>("centerTerminal");

const sidebarWidth = ref(260);
const navigatorWidth = ref(256);
const previewWidth = ref(1200);
const gitGraphHeight = ref(128);

/** Preview 開閉ボタンの固定幅（px-1 × 2 + size-4 + border-l） */
const PREVIEW_TOGGLE_WIDTH = 25;

/** Terminal 幅: ウィンドウ幅から Sidebar + H + Navigator + H + 開閉ボタンを引いた残余 */
const terminalWidth = computed(() => {
  const sidebarSpace = sidebarWidth.value + HANDLE_WIDTH;
  return Math.max(
    TERMINAL_MIN_WIDTH,
    windowWidth.value - sidebarSpace - navigatorWidth.value - HANDLE_WIDTH - PREVIEW_TOGGLE_WIDTH,
  );
});

/** ドラッグ開始時の Terminal 幅（レイアウト計算値） */
const getTerminalWidth = () => terminalWidth.value;

/** Preview popover に許容される最大幅（Sidebar + H + Terminal 最小幅 + H を残す） */
const maxPreviewWidth = computed(() => {
  const sidebarSpace = sidebarWidth.value + HANDLE_WIDTH;
  return (
    windowWidth.value -
    sidebarSpace -
    TERMINAL_MIN_WIDTH -
    HANDLE_WIDTH -
    navigatorWidth.value -
    PREVIEW_TOGGLE_WIDTH
  );
});

// ウィンドウ縮小時に Preview 幅をクランプ。書き換え対象 previewWidth は source に含めない
watch(
  maxPreviewWidth,
  (maxW) => {
    if (previewWidth.value > maxW) {
      previewWidth.value = Math.max(PREVIEW_MIN_WIDTH, maxW);
    }
  },
  { immediate: true },
);

/** ドラッグ開始時に popover 左側の空きスペースを返す（Navigator + 開閉ボタン分を除く） */
const getPreviewBeforeSize = () =>
  windowWidth.value - navigatorWidth.value - PREVIEW_TOGGLE_WIDTH - previewWidth.value;

/** ドラッグ開始時に Preview popover の DOM 実測幅を取得する */
const getPreviewAfterSize = () =>
  previewPopoverRef.value?.getBoundingClientRect().width ?? previewWidth.value;

// popover の DOM 参照を store に bind。template ref が null に戻った時点
// (= previewPopover element の unmount) に bindPopover(undefined) が呼ばれ
// dangling 参照を切る。
watch(
  previewPopoverRef,
  (el) => {
    previewStore.bindPopover(el ?? undefined);
  },
  { immediate: true },
);

// previewVisible context key を store の isOpen と同期
watch(
  () => previewStore.isOpen,
  (open) => {
    contextKeys.set("previewVisible", open);
  },
  { immediate: true },
);

/**
 * preview の open でフォーカスを popover へ移し、close で open 時点のフォーカス元へ戻す。
 *
 * cmd+w は「フォーカスのあるサーフェスを閉じる」意味論で terminalFocus により分岐する
 * (defaultKeyBindings.json)。popover の `showPopover()` はフォーカスを移さないため、
 * terminal リンク経由の open でフォーカスが terminal に残ると、開いた直後の cmd+w が
 * preview でなく terminal pane を閉じてしまう。open のたびに popover へフォーカスを
 * 引き直すことで防ぐ (VS Code の terminal link → editor focus と同じ意味論)。
 *
 * revealVersion を watch source に含めるのは、preview 表示中のファイル切替 (terminal
 * リンクの再クリック等) でも同じ理由でフォーカスを引き直すため。popover 内部に
 * フォーカスがある場合 (Monaco 編集中等) は奪わない。
 *
 * DOM フォーカスは view の関心なので、DOM なしでテストされる previewStore ではなく
 * popover 要素を所有する本コンポーネントが担う。
 */
let previewRestoreFocusEl: HTMLElement | undefined;
watch(
  () => [previewStore.isOpen, worktreeStore.revealVersion] as const,
  ([open], [wasOpen]) => {
    const el = previewPopoverRef.value;
    if (el === null) return;
    if (open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && el.contains(active)) return;
      previewRestoreFocusEl = active instanceof HTMLElement ? active : undefined;
      el.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen) return;
    // hidePopover の時点でフォーカスは body へ落ちているため、「popover がフォーカスを
    // 持っていたか」は判定できない。open→close 遷移では常に復帰を試みる (xterm の
    // hidden textarea 等。unmount 済み / 不可視なら focus() が no-op で body に留まる)
    if (previewRestoreFocusEl?.isConnected === true) {
      previewRestoreFocusEl.focus({ preventScroll: true });
    }
    previewRestoreFocusEl = undefined;
  },
);

// floatingWindowVisible context key を undock ウィンドウ (log / preview 全種) の有無と同期
watch(
  hasFloatingWindow,
  (has) => {
    contextKeys.set("floatingWindowVisible", has);
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

// ESC で preview を閉じる。popover="manual" によって OS の auto dismiss が無いため、
// HTML popover が popover="auto" で持っていた ESC dismiss の性質を自前で代替する。
// 他の popover (BlamePopover 等) や dialog (SettingsModal 等) が前面にあるときはそちらに ESC を譲り、
// すべて閉じた次の ESC で preview を閉じる。preventDefault は macOS の NSBeep 抑止に必須。
// 編集は常時編集 (edit mode トグル無し) のため ESC に編集系の意味は無い。未保存 draft が
// あれば requestClose の確認 (Save / Don't Save / Cancel) を挟む (close で破棄されるため)。
useEventListener(document, "keydown", (e: KeyboardEvent) => {
  if (e.defaultPrevented) return;
  if (isIMEActive(e) || e.key !== "Escape") return;
  if (!previewStore.isOpen) return;
  const otherPopoverOpen = Array.from(document.querySelectorAll<HTMLElement>(":popover-open")).some(
    (el) => el !== previewPopoverRef.value,
  );
  if (otherPopoverOpen) return;
  if (document.querySelector("dialog[open]") !== null) return;
  e.preventDefault();
  previewStore.requestClose();
});

/** 中央カラム内 Terminal の DOM 実測高さ（flex-1 のため v-model 不可） */
function getCenterTerminalHeight(): number {
  return centerTerminalRef.value?.offsetHeight ?? TERMINAL_MIN_HEIGHT;
}

// ウィンドウ縦縮小時に gitGraphHeight をクランプ（Terminal が潰れるのを防ぐ）。
// windowHeight はタイトルバー帯を含む renderer 全高なので、中央カラムの実高に
// 合わせて TITLEBAR_HEIGHT を差し引く。書き換え対象 gitGraphHeight は source に含めない
watch(
  windowHeight,
  (h) => {
    const maxGitGraph = h - TITLEBAR_HEIGHT - TERMINAL_MIN_HEIGHT - HANDLE_WIDTH;
    if (gitGraphHeight.value > maxGitGraph) {
      gitGraphHeight.value = Math.max(GIT_GRAPH_MIN_HEIGHT, maxGitGraph);
    }
  },
  { immediate: true },
);
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
        v-model:before-size="sidebarWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH"
        :after-min-size="TERMINAL_MIN_WIDTH"
        :get-after-size="getTerminalWidth"
      />

      <!-- 中央カラム: Terminal（上）+ GitGraph（下） -->
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div ref="centerTerminal" class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TerminalPane :min-width="TERMINAL_MIN_WIDTH" />
        </div>

        <template v-if="repoStore.selectedIsGitRepo">
          <ResizeHandle
            v-model:after-size="gitGraphHeight"
            direction="vertical"
            :before-min-size="TERMINAL_MIN_HEIGHT"
            :after-min-size="GIT_GRAPH_MIN_HEIGHT"
            :get-before-size="getCenterTerminalHeight"
          />
          <div class="shrink-0 overflow-hidden" :style="{ height: `${gitGraphHeight}px` }">
            <GitGraphPane />
          </div>
        </template>
      </div>

      <ResizeHandle
        v-model:after-size="navigatorWidth"
        direction="horizontal"
        :before-min-size="TERMINAL_MIN_WIDTH"
        :after-min-size="NAVIGATOR_MIN_WIDTH"
        :get-before-size="getTerminalWidth"
      />

      <!-- Preview 開閉ボタン（Preview popover のアンカー） -->
      <button
        type="button"
        class="_preview-anchor flex shrink-0 items-center justify-center border-l border-border px-1 text-foreground-low hover:text-foreground"
        title="Toggle preview"
        aria-label="Toggle preview"
        @click="previewStore.toggle()"
      >
        <IconLucidePanelRightOpen class="size-4" />
      </button>

      <div class="shrink-0 overflow-hidden" :style="{ width: `${navigatorWidth}px` }">
        <NavigatorPane />
      </div>
    </div>

    <!-- Preview popover: 開閉ボタンをアンカーにして左側に展開。
         tabindex="-1" は open 時のプログラムフォーカス移送用 (フォーカス移送 watch 参照)。
         tab 到達不能なパネル面へのフォーカスルーティングなので focus ring は出さない -->
    <div
      ref="previewPopover"
      popover="manual"
      tabindex="-1"
      class="_preview-popover overflow-hidden border-0 border-l border-border bg-background p-0 outline-hidden [&:popover-open]:flex"
      :style="{ width: `${previewWidth}px` }"
    >
      <!-- 左端リサイズハンドル -->
      <ResizeHandle
        v-model:after-size="previewWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH + HANDLE_WIDTH + TERMINAL_MIN_WIDTH + HANDLE_WIDTH"
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
    <FilePickerDialog />
    <PrPickerDialog />
    <IssuePickerDialog />
    <RevivePickerDialog />
    <SettingsModal />
    <BlamePopover />
    <FileHistoryPopover />
    <UnsavedDraftConfirmDialog />
    <NotificationToast />
    <NotificationCenterPanel />
  </div>
</template>

<style>
._preview-anchor {
  anchor-name: --preview-anchor;
}

._preview-popover {
  /* アンカーの左端に右端を揃え、タイトルバー下からウィンドウ下端まで表示
     （top-layer の popover はタイトルバーを覆ってドラッグ領域を塞ぐため下に逃がす） */
  position-anchor: --preview-anchor;
  inset: unset;
  margin: 0;
  top: var(--titlebar-height);
  bottom: 0;
  right: anchor(left);
  /* UA スタイル [popover] { height: fit-content } を打ち消す。
     height が auto でないと top + bottom の伸縮が効かずコンテンツ高さに縮む */
  height: auto;
  max-height: none;
}
</style>
