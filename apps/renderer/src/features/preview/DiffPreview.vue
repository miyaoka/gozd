<doc lang="md">
jsdiff の `diffLines` による行単位の unified diff ビュー。
追加行（緑）/ 削除行（赤）/ 変更なし行を旧行番号・新行番号付きで表示する。

## シンタックスハイライト

Shiki の `codeToTokens` で original / current それぞれのトークン配列を取得し、
diff の各行に対応するトークンをマッピングして色付き表示する。
removed 行は original のトークン、added / unchanged 行は current のトークンを使用する。

> [!NOTE]
> 複数行コメントやテンプレートリテラルの開始/終了が変更に含まれる場合、
> unchanged 行でも original と current でトークン結果が異なりうる。
> 現在は unchanged を常に current のトークンで描画するため、
> 旧側の文脈との不整合が生じる場合がある。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { diffLines } from "diff";
import { computed, ref, watch } from "vue";
import { type ThemedToken, highlightTokens } from "./useHighlight";

const props = defineProps<{
  original: string;
  current: string;
  filePath: string;
  wordWrap: boolean;
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

/** diff 結果の最大行番号から桁数を算出 */
const lineNoWidth = computed(() => {
  const maxLine = Math.max(props.original.split("\n").length, props.current.split("\n").length);
  return `${String(maxLine).length}ch`;
});

/** diff 行の背景色（テキスト色はトークンに任せる） */
const LINE_BG_CLASSES: Record<DiffLine["type"], string> = {
  added: "bg-green-400/10",
  removed: "bg-red-400/10",
  unchanged: "",
};

/** ハイライト未対応時のフォールバック色 */
const LINE_FALLBACK_CLASSES: Record<DiffLine["type"], string> = {
  added: "text-green-400 bg-green-400/10",
  removed: "text-red-400 bg-red-400/10",
  unchanged: "text-zinc-300",
};

/** original / current それぞれの行トークン配列 */
const originalTokens = ref<ThemedToken[][]>();
const currentTokens = ref<ThemedToken[][]>();

watch(
  () => [props.original, props.current, props.filePath],
  async (_, __, onCleanup) => {
    originalTokens.value = undefined;
    currentTokens.value = undefined;

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    const result = await tryCatch(
      Promise.all([
        highlightTokens(props.original, props.filePath),
        highlightTokens(props.current, props.filePath),
      ]),
    );
    if (cancelled || !result.ok) return;

    const [origTokens, currTokens] = result.value;
    originalTokens.value = origTokens;
    currentTokens.value = currTokens;
  },
  { immediate: true },
);

/** diff 行にトークン配列を付与した view model */
const diffLinesView = computed(() => {
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  if (!orig || !curr) return undefined;

  return diffResult.value.map((line) => {
    let tokens: ThemedToken[] | undefined;
    if (line.type === "removed" && line.oldLineNo !== undefined) {
      tokens = orig[line.oldLineNo - 1];
    } else if (line.newLineNo !== undefined) {
      tokens = curr[line.newLineNo - 1];
    }
    return { ...line, tokens };
  });
});
</script>

<template>
  <div class="p-4 text-sm/tight" :style="{ '--line-no-width': lineNoWidth }">
    <!-- ハイライト付き表示 -->
    <template v-if="diffLinesView">
      <div
        v-for="(line, i) in diffLinesView"
        :key="i"
        class="_diff-line"
        :class="LINE_BG_CLASSES[line.type]"
      >
        <span class="_line-no">{{ line.oldLineNo ?? "" }}</span>
        <span class="_line-no">{{ line.newLineNo ?? "" }}</span>
        <span class="_line-text" :class="wordWrap ? '_word-wrap' : ''">
          <span
            v-for="(token, j) in line.tokens"
            :key="j"
            :style="token.color ? { color: token.color } : undefined"
            >{{ token.content }}</span
          >
          <template v-if="!line.tokens">{{ line.text }}</template>
        </span>
      </div>
    </template>

    <!-- フォールバック: ハイライトなし -->
    <template v-else>
      <div
        v-for="(line, i) in diffResult"
        :key="i"
        class="_diff-line"
        :class="LINE_FALLBACK_CLASSES[line.type]"
      >
        <span class="_line-no">{{ line.oldLineNo ?? "" }}</span>
        <span class="_line-no">{{ line.newLineNo ?? "" }}</span>
        <span class="_line-text" :class="wordWrap ? '_word-wrap' : ''">{{ line.text }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
._diff-line {
  display: flex;
}

._line-no {
  display: inline-block;
  width: var(--line-no-width, 3ch);
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
  min-width: 0;
}

._line-text._word-wrap {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
