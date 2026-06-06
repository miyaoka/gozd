<doc lang="md">
設定モーダル。Cmd+, で開く統一設定画面。

## 構成

- 左タブ: Global / Project 切り替え
- 右コンテンツ: スキーマ駆動のセクション・ウィジェット一覧
- 値変更時に即座に RPC で保存
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { ref, watch } from "vue";
import { useDialog } from "../palette";
import { previewFontFamily, previewFontSize } from "../preview";
import { applyTerminalTheme, terminalFontFamily, terminalFontSize } from "../terminal";
import { useVoicevoxStore } from "../voicevox";
import { useWorktreeStore } from "../worktree";
import { globalSettingsSections } from "./globalSettingsSchema";
import { projectSettingsSections } from "./projectSettingsSchema";
import {
  flattenAppConfig,
  flattenProjectConfig,
  patchAppConfig,
  patchProjectConfig,
  rpcLoadAppConfig,
  rpcProjectConfigLoad,
} from "./rpc";
import SettingSection from "./SettingSection.vue";
import { useSettingsModal } from "./useSettingsModal";

type TabId = "global" | "project";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
];

const { Dialog, isOpen, show, close } = useDialog();
const { isOpen: modalIsOpen } = useSettingsModal();
const voicevoxStore = useVoicevoxStore();
const worktreeStore = useWorktreeStore();

const activeTab = ref<TabId>("global");
const loading = ref(true);
const globalValues = ref<Record<string, unknown>>({});
const projectValues = ref<Record<string, unknown>>({});

/** モーダルを開くときに設定を読み込む。load 完了後に dialog を表示する */
async function openWithSettings() {
  loading.value = true;
  const dir = worktreeStore.dir;
  const [globalResult, projectResult] = await Promise.all([
    tryCatch(rpcLoadAppConfig()),
    dir !== undefined ? tryCatch(rpcProjectConfigLoad({ dir })) : Promise.resolve(undefined),
  ]);
  if (globalResult.ok) {
    globalValues.value = flattenAppConfig(globalResult.value.config);
  }
  if (projectResult !== undefined && projectResult.ok) {
    projectValues.value = flattenProjectConfig(projectResult.value.config);
  }
  loading.value = false;
  show();
}

/** リアクティブ ref との同期マップ */
const REACTIVE_SYNC: Record<string, (value: unknown) => void> = {
  "terminal.fontFamily": (v) => {
    terminalFontFamily.value = typeof v === "string" ? v : "";
  },
  "terminal.fontSize": (v) => {
    terminalFontSize.value = typeof v === "number" ? v : 0;
  },
  "terminal.theme": (v) => {
    if (typeof v === "string") void applyTerminalTheme(v);
  },
  "preview.fontFamily": (v) => {
    previewFontFamily.value = typeof v === "string" ? v : "";
  },
  "preview.fontSize": (v) => {
    previewFontSize.value = typeof v === "number" ? v : 0;
  },
};

/** グローバル設定の値変更ハンドラー */
function handleGlobalChange(key: string, value: unknown) {
  globalValues.value[key] = value;

  // VOICEVOX store との同期（store の watch が configSave を発火）
  if (key === "voicevox.enabled") {
    if (value) {
      void voicevoxStore.activate().then((ok) => {
        if (!ok) {
          // activate 失敗時はトグルを戻す (notify.error は store 側で発火済み)
          globalValues.value[key] = false;
        }
      });
    } else {
      voicevoxStore.deactivate();
    }
    return;
  }
  if (key === "voicevox.speedScale" && typeof value === "number") {
    voicevoxStore.speedScale = value;
    return;
  }
  if (key === "voicevox.volumeScale" && typeof value === "number") {
    voicevoxStore.volumeScale = value;
    return;
  }

  // リアクティブ ref との同期
  REACTIVE_SYNC[key]?.(value);

  // 変更されたキーのみ patch 保存（他 UI で更新された値を巻き戻さない）
  void tryCatch(patchAppConfig({ [key]: value }));
}

/** プロジェクト設定の値変更ハンドラー */
function handleProjectChange(key: string, value: unknown) {
  projectValues.value[key] = value;
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  void tryCatch(patchProjectConfig(dir, { [key]: value }));
}

// modalIsOpen と dialog の isOpen を同期
watch(modalIsOpen, (open) => {
  if (open) {
    void openWithSettings();
  } else {
    close();
  }
});

// dialog の isOpen が false になったとき modalIsOpen も同期（Escape / backdrop）
watch(isOpen, (open) => {
  if (!open) {
    modalIsOpen.value = false;
  }
});
</script>

<template>
  <Dialog class="_settings-dialog" @close="modalIsOpen = false">
    <div
      class="flex max-h-[480px] w-[640px] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
    >
      <!-- ヘッダー -->
      <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 class="text-sm font-medium text-foreground-strong">Settings</h2>
        <button
          type="button"
          class="text-foreground-subtle hover:text-foreground"
          aria-label="Close settings"
          @click="modalIsOpen = false"
        >
          <span class="icon-[lucide--x] size-4" />
        </button>
      </div>

      <!-- 本体 -->
      <div class="flex min-h-0 flex-1">
        <!-- 左タブ -->
        <nav class="flex w-28 shrink-0 flex-col border-r border-border py-2">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="px-4 py-1.5 text-left text-sm"
            :class="
              activeTab === tab.id
                ? 'bg-accent-strong text-foreground-strong'
                : 'text-foreground-subtle hover:text-foreground'
            "
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- 右コンテンツ -->
        <div class="flex-1 overflow-y-auto p-4">
          <template v-if="activeTab === 'global'">
            <SettingSection
              v-for="section in globalSettingsSections"
              :key="section.title"
              :section="section"
              :values="globalValues"
              @change="handleGlobalChange"
            />
          </template>
          <template v-else>
            <SettingSection
              v-for="section in projectSettingsSections"
              :key="section.title"
              :section="section"
              :values="projectValues"
              @change="handleProjectChange"
            />
          </template>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<style>
._settings-dialog {
  margin: 15vh auto 0;
}

._settings-dialog::backdrop {
  background-color: rgb(0 0 0 / 0.3);
}
</style>
