<doc lang="md">
Preview のモード切替タブ (Original / Diff / Current) と Preview / Wrap トグルのツールバー。
タブラベル・アイコン・Preview トグル表示可否の計算をここに閉じ込め、PreviewPane の
テンプレートを単純参照に保つ。

- Original タブは `Original (<hash>)` 形式で実際に from として読んでいる ref を可視化する。
  `originalHashLabel` が undefined (commit 選択の不整合等) のときは hash 表記なしの "Original" に
  倒し、実際には参照していない HEAD などの虚偽情報をラベルに出さない
- Preview トグルは rendered 表示を持つファイル種別のみ、かつ diff モード以外で表示する
</doc>

<script setup lang="ts">
import { computed } from "vue";
import type { FunctionalComponent, SVGAttributes } from "vue";
import { hasRenderedView } from "./previewFileType";
import type { FileType } from "./previewFileType";
import type { PreviewMode } from "./previewMode";
import IconLucideEye from "~icons/lucide/eye";
import IconLucideFileClock from "~icons/lucide/file-clock";
import IconLucideFileDiff from "~icons/lucide/file-diff";
import IconLucideFileText from "~icons/lucide/file-text";
import IconLucideWrapText from "~icons/lucide/wrap-text";

const props = defineProps<{
  /** 選択ファイルの変更状態から導出された、表示可能なモード一覧 */
  modes: PreviewMode[];
  /** Original タブが指す hash の表記。undefined なら hash 表記なしの "Original" に倒す */
  originalHashLabel: string | undefined;
  fileType: FileType;
}>();

const activeMode = defineModel<PreviewMode>("activeMode", { required: true });
const previewEnabled = defineModel<boolean>("previewEnabled", { required: true });
const wordWrap = defineModel<boolean>("wordWrap", { required: true });

const MODE_ICONS: Record<PreviewMode, FunctionalComponent<SVGAttributes>> = {
  current: IconLucideFileText,
  diff: IconLucideFileDiff,
  original: IconLucideFileClock,
};

function modeLabel(mode: PreviewMode): string {
  if (mode === "current") return "Current";
  if (mode === "diff") return "Diff";
  const label = props.originalHashLabel;
  return label === undefined ? "Original" : `Original (${label})`;
}

/** preview チェックボックスを表示するか（diff モードでは非表示） */
const showPreviewCheckbox = computed(() => {
  if (activeMode.value === "diff") return false;
  return hasRenderedView(props.fileType);
});
</script>

<template>
  <div class="flex items-center border-b border-border">
    <!-- モード切替タブ -->
    <button
      v-for="mode in modes"
      :key="mode"
      class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
      :class="
        activeMode === mode
          ? 'border-b-2 border-primary text-primary-text'
          : 'text-foreground-low hover:text-foreground'
      "
      @click="activeMode = mode"
    >
      <component :is="MODE_ICONS[mode]" class="size-3.5" />
      {{ modeLabel(mode) }}
    </button>

    <div class="ml-auto flex items-center">
      <!-- Preview トグル -->
      <button
        v-if="showPreviewCheckbox"
        class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="previewEnabled ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'"
        @click="previewEnabled = !previewEnabled"
      >
        <IconLucideEye class="size-3.5" />
        Preview
      </button>

      <!-- Wrap トグル -->
      <button
        class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
        :class="wordWrap ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'"
        @click="wordWrap = !wordWrap"
      >
        <IconLucideWrapText class="size-3.5" />
        Wrap
      </button>
    </div>
  </div>
</template>
