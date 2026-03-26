<doc lang="md">
設定モーダル。Cmd+, で開く統一設定画面。

## 構成

- 左タブ: Global / Project 切り替え
- 右コンテンツ: スキーマ駆動のセクション・ウィジェット一覧
- 値変更時に即座に RPC で保存
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { reactive, watch } from "vue";
import { useRpc } from "../../shared/rpc";
import { useDialog } from "../palette";
import { previewFontFamily, previewFontSize } from "../preview";
import { applyTerminalTheme, terminalFontFamily, terminalFontSize } from "../terminal";
import { useVoicevoxStore } from "../voicevox";
import { globalSettingsSections } from "./globalSettingsSchema";
import { projectSettingsSections } from "./projectSettingsSchema";
import SettingSection from "./SettingSection.vue";
import { useSettingsModal } from "./useSettingsModal";

type TabId = "global" | "project";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
];

const { Dialog, isOpen, show, close } = useDialog();
const { isOpen: modalIsOpen } = useSettingsModal();
const { request } = useRpc();
const voicevoxStore = useVoicevoxStore();

const state = reactive({
  activeTab: "global" as TabId,
  loading: true,
  globalValues: {} as Record<string, unknown>,
  projectValues: {} as Record<string, unknown>,
});

/** モーダルを開くときに設定を読み込む。load 完了後に dialog を表示する */
async function openWithSettings() {
  state.loading = true;
  const [globalResult, projectResult] = await Promise.all([
    tryCatch(request.configLoad()),
    tryCatch(request.projectConfigLoad()),
  ]);
  if (globalResult.ok) {
    state.globalValues = { ...globalResult.value };
  }
  if (projectResult.ok) {
    state.projectValues = { ...projectResult.value };
  }
  state.loading = false;
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
  state.globalValues[key] = value;

  // VOICEVOX store との同期（store の watch が configSave を発火）
  if (key === "voicevox.enabled") {
    if (value) {
      void voicevoxStore.activate().then((errorMessage) => {
        if (errorMessage !== undefined) {
          // activate 失敗時はトグルを戻す
          state.globalValues[key] = false;
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
  void tryCatch(request.configSave({ [key]: value }));
}

/** プロジェクト設定の値変更ハンドラー */
function handleProjectChange(key: string, value: unknown) {
  state.projectValues[key] = value;
  void tryCatch(request.projectConfigSave({ [key]: value }));
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
      class="flex max-h-[480px] w-[640px] flex-col overflow-hidden rounded-lg border border-zinc-600 bg-zinc-800 shadow-2xl"
    >
      <!-- ヘッダー -->
      <div class="flex shrink-0 items-center justify-between border-b border-zinc-700 px-4 py-3">
        <h2 class="text-sm font-medium text-zinc-200">Settings</h2>
        <button
          type="button"
          class="text-zinc-500 hover:text-zinc-300"
          aria-label="Close settings"
          @click="modalIsOpen = false"
        >
          <span class="icon-[lucide--x] size-4" />
        </button>
      </div>

      <!-- 本体 -->
      <div class="flex min-h-0 flex-1">
        <!-- 左タブ -->
        <nav class="flex w-28 shrink-0 flex-col border-r border-zinc-700 py-2">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="px-4 py-1.5 text-left text-sm"
            :class="
              state.activeTab === tab.id
                ? 'bg-zinc-700/50 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300'
            "
            @click="state.activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- 右コンテンツ -->
        <div class="flex-1 overflow-y-auto p-4">
          <template v-if="state.activeTab === 'global'">
            <SettingSection
              v-for="section in globalSettingsSections"
              :key="section.title"
              :section="section"
              :values="state.globalValues"
              @change="handleGlobalChange"
            />
          </template>
          <template v-else>
            <SettingSection
              v-for="section in projectSettingsSections"
              :key="section.title"
              :section="section"
              :values="state.projectValues"
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
  padding: 0;
  border: none;
  background: transparent;
  margin: 15vh auto 0;
}

._settings-dialog::backdrop {
  background-color: rgb(0 0 0 / 0.3);
}
</style>
