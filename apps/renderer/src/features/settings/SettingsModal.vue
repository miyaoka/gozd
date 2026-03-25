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
import { useDialog } from "../../shared/quick-pick";
import { useRpc } from "../../shared/rpc";
import { applyTerminalTheme } from "../terminal";
import { useVoicevoxStore } from "../voicevox";
import { globalSettingsSections } from "./globalSettingsSchema";
import { getNestedValue, setNestedValue } from "./nestedAccess";
import { projectSettingsSections } from "./projectSettingsSchema";
import SettingSection from "./SettingSection.vue";
import type { SettingSection as SettingSectionType } from "./types";
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
  globalValues: {} as Record<string, unknown>,
  projectValues: {} as Record<string, unknown>,
});

/** スキーマからフラットな値マップを構築する */
function flattenConfig(
  sections: readonly SettingSectionType[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const section of sections) {
    for (const key of Object.keys(section.settings)) {
      const value = getNestedValue(config, key);
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** モーダルを開くときに設定を読み込む */
async function loadSettings() {
  const [globalResult, projectResult] = await Promise.all([
    tryCatch(request.configLoad()),
    tryCatch(request.projectConfigLoad()),
  ]);
  if (globalResult.ok) {
    state.globalValues = flattenConfig(
      globalSettingsSections,
      globalResult.value as Record<string, unknown>,
    );
  }
  if (projectResult.ok) {
    state.projectValues = flattenConfig(
      projectSettingsSections,
      projectResult.value as Record<string, unknown>,
    );
  }
}

/** フラットな値マップからネスト構造に復元する */
function unflattenValues(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    setNestedValue(result, key, value);
  }
  return result;
}

/** グローバル設定の値変更ハンドラー */
function handleGlobalChange(key: string, value: unknown) {
  state.globalValues[key] = value;

  // VOICEVOX store との同期
  if (key === "voicevox.enabled") {
    if (value) {
      void voicevoxStore.activate();
    } else {
      voicevoxStore.deactivate();
    }
    return;
  }
  if (key === "voicevox.speedScale" && typeof value === "number") {
    voicevoxStore.speedScale = value;
    // store の watch が configSave を発火するので、ここでは RPC 呼び出し不要
    return;
  }
  if (key === "voicevox.volumeScale" && typeof value === "number") {
    voicevoxStore.volumeScale = value;
    return;
  }

  // テーマ変更
  if (key === "terminalTheme" && typeof value === "string") {
    void applyTerminalTheme(value);
  }

  // 汎用保存（VOICEVOX 以外）
  const config = unflattenValues(state.globalValues);
  void tryCatch(request.configSave(config));
}

/** プロジェクト設定の値変更ハンドラー */
function handleProjectChange(key: string, value: unknown) {
  state.projectValues[key] = value;
  const config = unflattenValues(state.projectValues);
  void tryCatch(request.projectConfigSave(config));
}

// modalIsOpen と dialog の isOpen を同期
watch(modalIsOpen, (open) => {
  if (open) {
    void loadSettings();
    show();
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
