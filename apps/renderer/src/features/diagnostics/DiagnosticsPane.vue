<doc lang="md">
LSP 診断結果の一覧表示パネル。エラー・警告をファイルごとにグループ化して表示する。
</doc>

<script setup lang="ts">
import { useDiagnostics } from "./useDiagnostics";

const { errorFiles, warningFiles, errorCount, warningCount } = useDiagnostics();

/** severity に応じたアイコン・色のマッピング */
const SEVERITY_STYLES = {
  error: { icon: "icon-[lucide--circle-x]", color: "text-red-400" },
  warning: { icon: "icon-[lucide--triangle-alert]", color: "text-yellow-400" },
} as const;
</script>

<template>
  <div
    class="size-full overflow-y-auto rounded-sm border border-zinc-700 bg-zinc-800 p-3 font-mono text-sm text-zinc-300"
  >
    <div class="mb-1 flex items-center gap-2 font-bold text-zinc-400">
      <span class="icon-[lucide--stethoscope]" />
      Diagnostics
      <span v-if="errorCount > 0" class="flex items-center gap-0.5 text-xs text-red-400">
        <span :class="SEVERITY_STYLES.error.icon" class="size-3" />
        {{ errorCount }}
      </span>
      <span v-if="warningCount > 0" class="flex items-center gap-0.5 text-xs text-yellow-400">
        <span :class="SEVERITY_STYLES.warning.icon" class="size-3" />
        {{ warningCount }}
      </span>
      <span v-if="errorCount === 0 && warningCount === 0" class="text-xs font-normal text-zinc-500">
        no issues
      </span>
    </div>

    <!-- エラー一覧 -->
    <template v-if="errorFiles.length > 0">
      <div v-for="file in errorFiles" :key="`e-${file.relPath}`" class="mt-1">
        <div class="truncate text-xs text-red-400" :title="file.relPath">
          {{ file.relPath }}
        </div>
        <div
          v-for="(diag, i) in file.diagnostics"
          :key="i"
          class="truncate pl-3 text-xs text-zinc-400"
          :title="diag.message"
        >
          <span class="text-zinc-500">{{ diag.startLine + 1 }}:{{ diag.startCharacter + 1 }}</span>
          {{ diag.message }}
        </div>
      </div>
    </template>

    <!-- 警告一覧 -->
    <template v-if="warningFiles.length > 0">
      <div v-for="file in warningFiles" :key="`w-${file.relPath}`" class="mt-1">
        <div class="truncate text-xs text-yellow-400" :title="file.relPath">
          {{ file.relPath }}
        </div>
        <div
          v-for="(diag, i) in file.diagnostics"
          :key="i"
          class="truncate pl-3 text-xs text-zinc-400"
          :title="diag.message"
        >
          <span class="text-zinc-500">{{ diag.startLine + 1 }}:{{ diag.startCharacter + 1 }}</span>
          {{ diag.message }}
        </div>
      </div>
    </template>
  </div>
</template>
