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
import { useEventListener, useWindowSize } from "@vueuse/core";
import { computed, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useCommandRegistry, useContextKeys } from "../../shared/command";
import { useRepoStore } from "../../shared/repo";
import { useChangesSummaryStore } from "../changes";
import { GitGraphPane } from "../git-graph";
import { NavigatorPane } from "../navigator";
import {
  CommandPalette,
  IssuePickerDialog,
  PrPickerDialog,
  QuickPick,
  registerIssueCommand,
  registerPrCommand,
} from "../palette";
import { BlamePopover, PreviewPane, registerMarkdownHistoryCommands } from "../preview";
import { registerSettingsCommand, SettingsModal } from "../settings";
import { registerShellCommandActions } from "../shell-command";
import { SidebarPane } from "../sidebar";
import { registerThemeCommand, TerminalPane } from "../terminal";
import { useWorktreeStore } from "../worktree";
import NotificationToast from "./NotificationToast.vue";
import ResizeHandle from "./ResizeHandle.vue";
import { rpcWindowClose } from "./rpc";

const worktreeStore = useWorktreeStore();
const repoStore = useRepoStore();
const summaryStore = useChangesSummaryStore();
const contextKeys = useContextKeys();
const previewPopoverRef = useTemplateRef<HTMLElement>("previewPopover");

// レイアウト・ウィンドウスコープのコマンド登録
const { register } = useCommandRegistry();
const disposePreviewToggle = register("preview.toggle", {
  label: "Preview: Toggle",
  handler: () => {
    if (previewOpen.value) {
      closePreview();
    } else {
      openPreview();
    }
    return true;
  },
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
const disposePrCommand = registerPrCommand();
const disposeIssueCommand = registerIssueCommand();
const disposeShellCommandActions = registerShellCommandActions();
const disposeMarkdownHistoryCommands = registerMarkdownHistoryCommands();
onUnmounted(disposePreviewToggle);
onUnmounted(disposeWindowClose);
onUnmounted(disposeThemeCommand);
onUnmounted(disposeSettingsCommand);
onUnmounted(disposePrCommand);
onUnmounted(disposeIssueCommand);
onUnmounted(disposeShellCommandActions);
onUnmounted(disposeMarkdownHistoryCommands);

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
const previewOpen = ref(false);
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

// previewVisible context key を実際の表示状態と同期
watch(
  previewOpen,
  (open) => {
    contextKeys.set("previewVisible", open);
  },
  { immediate: true },
);

/** :popover-open でガードして二重呼び出し例外を防止 */
function openPreview() {
  const el = previewPopoverRef.value;
  if (!el || el.matches(":popover-open")) return;
  el.showPopover();
}

function closePreview() {
  const el = previewPopoverRef.value;
  if (!el || !el.matches(":popover-open")) return;
  el.hidePopover();
}

/** popover の toggle イベントで previewOpen ref と同期 */
function onPreviewToggle(e: ToggleEvent) {
  previewOpen.value = e.newState === "open";
}

// ESC で preview を閉じる。popover="manual" によって OS の auto dismiss が無いため、
// HTML popover が popover="auto" で持っていた ESC dismiss の性質を自前で代替する。
// 他の popover (BlamePopover 等) や dialog (SettingsModal 等) が前面にあるときはそちらに ESC を譲り、
// すべて閉じた次の ESC で preview を閉じる。preventDefault は macOS の NSBeep 抑止に必須。
useEventListener(document, "keydown", (e: KeyboardEvent) => {
  if (e.defaultPrevented) return;
  if (isIMEActive(e) || e.key !== "Escape") return;
  if (!previewOpen.value) return;
  const otherPopoverOpen = Array.from(document.querySelectorAll<HTMLElement>(":popover-open")).some(
    (el) => el !== previewPopoverRef.value,
  );
  if (otherPopoverOpen) return;
  if (document.querySelector("dialog[open]") !== null) return;
  e.preventDefault();
  closePreview();
});

// worktree 切替 (dir 変化) で新 dir 上に選択ファイルが無ければ Preview を auto-close。
// setOpen は selectDir → selectRelPath を同期で続けて呼ぶ経路があるため (gozdOpen 経由で
// 別 worktree のファイルを selection 付きで指定するケース)、close 判定を flush: 'post' まで
// 遅らせて selection 確定後の selectedDisplayPath を観測する。selection ありで切り替わった
// 場合は close せず、後続の selectedDisplayPath watch の auto-open に委ねることで
// 「close → 即 open」のちらつきを避ける。
watch(
  () => worktreeStore.dir,
  () => {
    if (worktreeStore.selectedDisplayPath === undefined) {
      closePreview();
    }
  },
  { flush: "post" },
);

// ファイル選択時に Preview を自動オープン (path 軸で識別; selection object identity の発火は避ける)
watch(
  () => worktreeStore.selectedDisplayPath,
  (path) => {
    if (path === undefined) return;
    openPreview();
  },
);

// gozdOpen で同一パスが指定された場合にも Preview を開く
watch(
  () => worktreeStore.revealVersion,
  () => {
    if (worktreeStore.selectedDisplayPath === undefined) return;
    openPreview();
  },
);

// Changes summary が有効化されたら Preview popover を自動で開く
watch(
  () => summaryStore.enabled,
  (enabled) => {
    if (enabled) openPreview();
  },
);

/** 中央カラム内 Terminal の DOM 実測高さ（flex-1 のため v-model 不可） */
function getCenterTerminalHeight(): number {
  return centerTerminalRef.value?.offsetHeight ?? TERMINAL_MIN_HEIGHT;
}

// ウィンドウ縦縮小時に gitGraphHeight をクランプ（Terminal が潰れるのを防ぐ）。
// 書き換え対象 gitGraphHeight は source に含めない
watch(
  windowHeight,
  (h) => {
    const maxGitGraph = h - TERMINAL_MIN_HEIGHT - HANDLE_WIDTH;
    if (gitGraphHeight.value > maxGitGraph) {
      gitGraphHeight.value = Math.max(GIT_GRAPH_MIN_HEIGHT, maxGitGraph);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="_main-layout flex h-screen flex-col overflow-hidden bg-zinc-900 text-white">
    <!-- native titleBar は Liquid Glass の半透明 surface として WebView の上に乗る。
         WebView は `ignoresSafeArea(.container, edges: .top)` で titlebar の下まで延びるため、
         renderer 側で `env(safe-area-inset-top)` 分の padding を取って in-app コンテンツが
         titlebar の真下に隠れないように reservation する。 -->

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
        class="_preview-anchor flex shrink-0 items-center justify-center border-l border-zinc-700 px-1 text-zinc-500 hover:text-zinc-300"
        title="Toggle preview"
        aria-label="Toggle preview"
        @click="previewOpen ? closePreview() : openPreview()"
      >
        <span class="icon-[lucide--panel-right-open] size-4" />
      </button>

      <div class="shrink-0 overflow-hidden" :style="{ width: `${navigatorWidth}px` }">
        <NavigatorPane />
      </div>
    </div>

    <!-- Preview popover: 開閉ボタンをアンカーにして左側に展開 -->
    <div
      ref="previewPopover"
      popover="manual"
      class="_preview-popover overflow-hidden border-0 border-l border-zinc-700 bg-zinc-900 p-0 [&:popover-open]:flex"
      :style="{ width: `${previewWidth}px` }"
      @toggle="onPreviewToggle"
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
        <PreviewPane @close="closePreview" />
      </div>
    </div>

    <CommandPalette />
    <QuickPick />
    <PrPickerDialog />
    <IssuePickerDialog />
    <SettingsModal />
    <BlamePopover />
    <NotificationToast />
  </div>
</template>

<style>
._main-layout {
  /* WebView は native titlebar (Liquid Glass) の下まで延びる。
     titlebar 高さ分の reservation を取って in-app コンテンツが隠れないようにする。 */
  padding-top: env(safe-area-inset-top);
}

._preview-anchor {
  anchor-name: --preview-anchor;
}

._preview-popover {
  /* アンカーの左端に右端を揃え、ウィンドウ全高で表示 */
  position-anchor: --preview-anchor;
  inset: unset;
  margin: 0;
  top: 0;
  bottom: 0;
  right: anchor(left);
  height: 100dvh;
  max-height: none;
}
</style>
