<script setup lang="ts">
import { diffLines } from "diff";
import { computed } from "vue";

const props = defineProps<{
  original: string;
  current: string;
}>();

interface DiffLine {
  text: string;
  type: "added" | "removed" | "unchanged";
  oldLineNo?: number;
  newLineNo?: number;
}

const diffResult = computed<DiffLine[]>(() => {
  const changes = diffLines(props.original, props.current);
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const change of changes) {
    const changeLines = change.value.replace(/\n$/, "").split("\n");
    for (const text of changeLines) {
      if (change.removed) {
        lines.push({ text, type: "removed", oldLineNo: oldLine++ });
      } else if (change.added) {
        lines.push({ text, type: "added", newLineNo: newLine++ });
      } else {
        lines.push({ text, type: "unchanged", oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }
  }
  return lines;
});

const LINE_TYPE_CLASSES: Record<DiffLine["type"], string> = {
  added: "text-green-400 bg-green-400/10",
  removed: "text-red-400 bg-red-400/10",
  unchanged: "text-zinc-300",
};
</script>

<template>
  <div class="p-4 text-sm/tight">
    <div
      v-for="(line, i) in diffResult"
      :key="i"
      class="_diff-line"
      :class="LINE_TYPE_CLASSES[line.type]"
    >
      <span class="_line-no">{{ line.oldLineNo ?? "" }}</span>
      <span class="_line-no">{{ line.newLineNo ?? "" }}</span>
      <span class="_line-text">{{ line.text }}</span>
    </div>
  </div>
</template>

<style scoped>
._diff-line {
  display: flex;
}

._line-no {
  display: inline-block;
  width: 3ch;
  flex-shrink: 0;
  text-align: right;
  color: var(--color-zinc-600);
  user-select: none;
}

._line-no + ._line-text {
  margin-left: 1.5ch;
}

._line-text {
  white-space: pre;
}
</style>
