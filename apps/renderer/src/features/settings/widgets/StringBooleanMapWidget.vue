<doc lang="md">
glob → boolean マップ設定用の行リスト editor（VS Code の files.watcherExclude 相当）。

各行は glob パターン + 有効トグル + 削除ボタン。value === false は「seed 済み default を
無効化する」subtraction を表すため、削除せずトグルで無効化もできる。空 glob の行は編集中の
一時状態として保持し、マップには含めない（`rowsToMap` で除外）。

model（Record）↔ rows（順序を持つ配列）の双方向同期は、自分の編集で生じた model 変更を
`rowsToMap(rows)` との一致で検出してスキップし、フィードバックループを避ける。
</doc>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { StringBooleanMapSetting } from "../types";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideTrash2 from "~icons/lucide/trash-2";

const props = defineProps<{
  setting: StringBooleanMapSetting;
}>();

const model = defineModel<Record<string, boolean>>({ required: true });

interface Row {
  pattern: string;
  enabled: boolean;
}

const rows = ref<Row[]>([]);

function mapToRows(map: Record<string, boolean>): Row[] {
  return Object.entries(map).map(([pattern, enabled]) => ({ pattern, enabled }));
}

function rowsToMap(list: Row[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const { pattern, enabled } of list) {
    const key = pattern.trim();
    // 空 glob は編集中の行としてローカルに残し、マップには入れない
    if (key === "") continue;
    map[key] = enabled;
  }
  return map;
}

// 外部（初回 load / 他経路の更新）からの model 変更のみ rows に反映する。
// 自分の commit で生じた変更は rowsToMap(rows) と一致するためスキップする
watch(
  model,
  (map) => {
    if (JSON.stringify(rowsToMap(rows.value)) === JSON.stringify(map)) return;
    rows.value = mapToRows(map);
  },
  { immediate: true },
);

function commit(): void {
  model.value = rowsToMap(rows.value);
}

function addRow(): void {
  rows.value.push({ pattern: "", enabled: true });
}

function removeRow(index: number): void {
  rows.value.splice(index, 1);
  commit();
}
</script>

<template>
  <div class="flex w-72 flex-col gap-1.5">
    <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-1.5">
      <input
        v-model="row.pattern"
        type="text"
        class="min-w-0 flex-1 rounded-sm border border-border-strong bg-element px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
        :placeholder="props.setting.placeholder"
        @change="commit"
      />
      <button
        type="button"
        role="switch"
        :aria-checked="row.enabled"
        aria-label="Enabled"
        class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
        :class="row.enabled ? 'bg-primary' : 'bg-element-hover'"
        @click="
          row.enabled = !row.enabled;
          commit();
        "
      >
        <span
          class="pointer-events-none inline-block size-4 rounded-full bg-foreground shadow-sm transition-transform"
          :class="row.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'"
          :style="{ marginTop: '2px' }"
        />
      </button>
      <button
        type="button"
        aria-label="Remove pattern"
        class="shrink-0 cursor-pointer rounded-sm p-1 text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="removeRow(index)"
      >
        <IconLucideTrash2 class="size-4" />
      </button>
    </div>
    <button
      type="button"
      class="flex cursor-pointer items-center gap-1 self-start rounded-sm px-2 py-1 text-xs text-foreground-low hover:bg-element-hover hover:text-foreground"
      @click="addRow"
    >
      <IconLucidePlus class="size-3.5" />
      Add Pattern
    </button>
  </div>
</template>
