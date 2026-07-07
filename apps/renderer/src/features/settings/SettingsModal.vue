<doc lang="md">
設定モーダル。Cmd+, で開く統一設定画面。

## 構成

- 左タブ: Global / Project 切り替え
- 右コンテンツ: スキーマ駆動のセクション・ウィジェット一覧
- 値変更時に即座に RPC で保存

## Project タブの対象

Project 設定はアクティブ worktree が属するプロジェクトを対象にする（`worktreeStore.dir` から
`resolveProjectKey` で解決）。アクティブ worktree が無いと対象が定まらず、保存経路が dir 不在で
握りつぶすため、Project タブを無効化する（対象名も UI に明示して複数 repo 時の曖昧さを消す）。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { useDialog } from "../palette";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "../preview";
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
import IconLucideX from "~icons/lucide/x";

type TabId = "global" | "project";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
];

const { Dialog, isOpen, show, close } = useDialog();
const { isOpen: modalIsOpen } = useSettingsModal();
const voicevoxStore = useVoicevoxStore();
const worktreeStore = useWorktreeStore();
const repoStore = useRepoStore();
const notify = useNotificationStore();

/**
 * project 設定の対象 dir（= アクティブな worktree）。undefined なら対象プロジェクトが
 * 定まらないため Project タブは無効化する（対象不在で編集を握りつぶさないため）。
 */
const projectDir = computed(() => worktreeStore.dir);

/** 対象プロジェクトの表示名。設定 UI にどの project を編集中かを明示する */
const projectName = computed(() => {
  const dir = projectDir.value;
  if (dir === undefined) return undefined;
  return repoStore.findRepoOwning(dir)?.repoName ?? dir;
});

const activeTab = ref<TabId>("global");
const loading = ref(true);
const globalValues = ref<Record<string, unknown>>({});
const projectValues = ref<Record<string, unknown>>({});

/** モーダルを開くときに設定を読み込む。load 完了後に dialog を表示する */
// 対象プロジェクトが外れたら Project タブに留まらせない（無効タブでの空編集を防ぐ）
watch(projectDir, (dir) => {
  if (dir === undefined && activeTab.value === "project") activeTab.value = "global";
});

async function openWithSettings() {
  loading.value = true;
  const dir = worktreeStore.dir;
  // 対象不在で開いた場合は Global に固定して開く（Project タブは無効表示になる）
  if (dir === undefined) activeTab.value = "global";
  const [globalResult, projectResult] = await Promise.all([
    tryCatch(rpcLoadAppConfig()),
    dir !== undefined ? tryCatch(rpcProjectConfigLoad({ dir })) : Promise.resolve(undefined),
  ]);
  if (globalResult.ok) {
    globalValues.value = flattenAppConfig(globalResult.value.config);
  } else {
    notify.error("Failed to load settings", globalResult.error);
  }
  if (projectResult !== undefined) {
    if (projectResult.ok) {
      projectValues.value = flattenProjectConfig(projectResult.value.config);
    } else {
      notify.error("Failed to load project settings", projectResult.error);
    }
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
  "preview.codeFontFamily": (v) => {
    previewCodeFontFamily.value = typeof v === "string" ? v : "";
  },
};

/** グローバル設定の値変更ハンドラー */
async function handleGlobalChange(key: string, value: unknown) {
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
  const result = await tryCatch(patchAppConfig({ [key]: value }));
  if (!result.ok) notify.error("Failed to save settings", result.error);
}

/** プロジェクト設定の値変更ハンドラー */
async function handleProjectChange(key: string, value: unknown) {
  projectValues.value[key] = value;
  const dir = worktreeStore.dir;
  if (dir === undefined) return;
  const result = await tryCatch(patchProjectConfig(dir, { [key]: value }));
  if (!result.ok) notify.error("Failed to save project settings", result.error);
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
      class="flex max-h-[480px] w-[640px] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <!-- ヘッダー -->
      <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 class="text-sm font-medium text-foreground">Settings</h2>
        <button
          type="button"
          class="text-foreground-low hover:text-foreground"
          aria-label="Close settings"
          @click="modalIsOpen = false"
        >
          <IconLucideX class="size-4" />
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
            class="px-4 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:text-foreground-muted disabled:hover:text-foreground-muted"
            :class="
              activeTab === tab.id
                ? 'bg-element-active text-foreground'
                : 'text-foreground-low hover:text-foreground'
            "
            :disabled="tab.id === 'project' && projectDir === undefined"
            :title="
              tab.id === 'project' && projectDir === undefined
                ? 'Open a worktree to edit its project settings'
                : undefined
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
            <div class="mb-3 flex items-baseline gap-2 border-b border-border pb-2">
              <span class="text-xs text-foreground-low">Project</span>
              <span class="truncate text-sm text-foreground">{{ projectName }}</span>
            </div>
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
