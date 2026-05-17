<doc lang="md">
hunk 単位の unified diff ビュー。

## 設計

diff 計算は SSOT を git に置き、renderer は `rpcGitDiffHunks` で取得した `hunks` を描画するだけ。
全文 jsdiff を JS で回すと大ファイル (`pnpm-lock.yaml` 等) で Myers LCS が O(N×M) で
固まるため、git の C 実装 (xdiff) に処理を委ねる。

## 描画

`hunksToViewItems` で hunk 配列を `DiffViewItem[]` に展開する:

- 各 hunk 行を `{ type: "line", ... }` として並べる
- hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `{ type: "hunk-bar", oldGap, newGap }` で静的に表示

split view (#540) では同じ hunks を別の `hunksToSplitRows` 系関数に渡せば 4 列構造に再構築できる前提で
view item の生成を関数として独立させている。

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
import { type DiffHunk, DiffLineKind } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitDiffHunks } from "./rpc";
import { type ThemedToken, highlightTokens } from "./useHighlight";

const props = defineProps<{
  original: string;
  current: string;
  filePath: string;
  wordWrap: boolean;
}>();

type DiffLineKindName = "added" | "removed" | "unchanged";

interface DiffLineItem {
  type: "line";
  kind: DiffLineKindName;
  text: string;
  oldLineNo?: number;
  newLineNo?: number;
}

interface DiffBarItem {
  type: "hunk-bar";
  /** バーが省略している unchanged 行数 (old/new で一致するはずだが個別に保持) */
  oldGap: number;
  newGap: number;
}

type DiffViewItem = DiffLineItem | DiffBarItem;

const notification = useNotificationStore();

const hunks = ref<DiffHunk[]>();
const loading = ref(false);

/**
 * hunk 配列を render 用の view item 列に展開する。
 *
 * - hunk 内の各 line を `DiffLineItem` に変換
 * - 隣接 hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `DiffBarItem` で省略表示
 *
 * #540 で「バーのクリックで該当範囲を context 拡張 diff として取り直す」拡張をする際は
 * `DiffBarItem` に range 情報を足してこの関数を変更する。split view も同じ hunks を別関数で
 * 4 列展開する想定。
 */
function hunksToViewItems(hs: DiffHunk[], totalOld: number, totalNew: number): DiffViewItem[] {
  const items: DiffViewItem[] = [];
  // 前 hunk の終端 (1-based、未開始は 0)
  let prevOldEnd = 0;
  let prevNewEnd = 0;

  for (const h of hs) {
    // 前 hunk と現 hunk の間に存在する unchanged 行をバーで省略
    const oldGap = h.oldStart - prevOldEnd - 1;
    const newGap = h.newStart - prevNewEnd - 1;
    if (oldGap > 0 || newGap > 0) {
      items.push({ type: "hunk-bar", oldGap, newGap });
    }

    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const line of h.lines) {
      if (line.kind === DiffLineKind.DIFF_LINE_KIND_REMOVED) {
        items.push({ type: "line", kind: "removed", text: line.text, oldLineNo: oldLine });
        oldLine += 1;
      } else if (line.kind === DiffLineKind.DIFF_LINE_KIND_ADDED) {
        items.push({ type: "line", kind: "added", text: line.text, newLineNo: newLine });
        newLine += 1;
      } else {
        items.push({
          type: "line",
          kind: "unchanged",
          text: line.text,
          oldLineNo: oldLine,
          newLineNo: newLine,
        });
        oldLine += 1;
        newLine += 1;
      }
    }
    prevOldEnd = h.oldStart + h.oldLines - 1;
    prevNewEnd = h.newStart + h.newLines - 1;
  }

  // 最終 hunk 以降の trailing unchanged
  const trailingOld = totalOld - prevOldEnd;
  const trailingNew = totalNew - prevNewEnd;
  if (trailingOld > 0 || trailingNew > 0) {
    items.push({ type: "hunk-bar", oldGap: trailingOld, newGap: trailingNew });
  }

  return items;
}

/** 末尾改行を 1 個分だけ無視した行数 (split("\n").length と同じ計算) */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const endsWithNewline = text.endsWith("\n");
  const n = text.split("\n").length;
  return endsWithNewline ? n - 1 : n;
}

const totalOldLines = computed(() => countLines(props.original));
const totalNewLines = computed(() => countLines(props.current));

const viewItems = computed<DiffViewItem[]>(() => {
  if (!hunks.value) return [];
  return hunksToViewItems(hunks.value, totalOldLines.value, totalNewLines.value);
});

watch(
  () => [props.original, props.current] as const,
  async ([original, current], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    loading.value = true;
    const result = await tryCatch(rpcGitDiffHunks({ original, current }));
    if (cancelled) return;
    loading.value = false;

    if (!result.ok) {
      hunks.value = [];
      notification.error("Failed to compute diff", result.error);
      return;
    }
    hunks.value = result.value.hunks;
  },
  { immediate: true },
);

/** diff 行番号からの桁数 (split / commit 切替時の幅一定化) */
const lineNoWidth = computed(() => {
  const maxLine = Math.max(totalOldLines.value, totalNewLines.value);
  return `${String(Math.max(maxLine, 1)).length}ch`;
});

const LINE_BG_CLASSES: Record<DiffLineKindName, string> = {
  added: "bg-green-400/10",
  removed: "bg-red-400/10",
  unchanged: "",
};

const LINE_FALLBACK_CLASSES: Record<DiffLineKindName, string> = {
  added: "text-green-400 bg-green-400/10",
  removed: "text-red-400 bg-red-400/10",
  unchanged: "text-zinc-300",
};

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

/** 各行を token 配列付きの描画モデルに変換 */
const renderRows = computed(() => {
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  return viewItems.value.map((item) => {
    if (item.type === "hunk-bar") return item;
    let tokens: ThemedToken[] | undefined;
    if (orig && curr) {
      if (item.kind === "removed" && item.oldLineNo !== undefined) {
        tokens = orig[item.oldLineNo - 1];
      } else if (item.newLineNo !== undefined) {
        tokens = curr[item.newLineNo - 1];
      }
    }
    return { ...item, tokens };
  });
});

const tokensReady = computed(
  () => originalTokens.value !== undefined && currentTokens.value !== undefined,
);

function barLabel(item: DiffBarItem): string {
  const lines = Math.max(item.oldGap, item.newGap);
  return `${lines} unchanged line${lines === 1 ? "" : "s"}`;
}
</script>

<template>
  <div class="p-4 text-sm/tight" :style="{ '--line-no-width': lineNoWidth }">
    <div v-if="loading && !hunks" class="text-zinc-500">Computing diff...</div>

    <template v-else>
      <template v-for="(row, i) in renderRows" :key="i">
        <!-- hunk 間 / 先頭・末尾の連続 unchanged 行を省略するバー -->
        <div v-if="row.type === 'hunk-bar'" class="_hunk-bar">
          <span class="_hunk-bar-icon icon-[lucide--more-horizontal] size-3.5" />
          <span>{{ barLabel(row) }}</span>
        </div>

        <!-- diff 行 -->
        <div
          v-else
          class="_diff-line"
          :class="tokensReady ? LINE_BG_CLASSES[row.kind] : LINE_FALLBACK_CLASSES[row.kind]"
        >
          <span class="_line-no">{{ row.oldLineNo ?? "" }}</span>
          <span class="_line-no">{{ row.newLineNo ?? "" }}</span>
          <span class="_line-text" :class="wordWrap ? '_word-wrap' : ''">
            <template v-if="row.tokens">
              <span
                v-for="(token, j) in row.tokens"
                :key="j"
                :style="token.color ? { color: token.color } : undefined"
                >{{ token.content }}</span
              >
            </template>
            <template v-else>{{ row.text }}</template>
          </span>
        </div>
      </template>
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

._hunk-bar {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.25rem 0.5rem;
  margin: 0.25rem 0;
  background-color: var(--color-zinc-800);
  color: var(--color-zinc-500);
  font-size: 0.75rem;
  user-select: none;
}

._hunk-bar-icon {
  flex-shrink: 0;
}
</style>
