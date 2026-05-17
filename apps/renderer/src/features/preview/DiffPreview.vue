<doc lang="md">
hunk 単位の unified diff ビュー。

## 設計

diff 計算は SSOT を git に置き、renderer は `rpcGitDiffHunks` で取得した `hunks` と
`oldTotalLines` / `newTotalLines` を描画するだけ。全文 jsdiff を JS で回すと
大ファイル (`pnpm-lock.yaml` 等) で Myers LCS が O(N×M) で固まるため、
git の C 実装 (xdiff) に処理を委ねる。

## 描画

`hunksToViewItems` で hunk 配列を `DiffViewItem[]` に展開する:

- 各 hunk 行を `{ type: "line", ... }` として並べる
- hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `{ type: "hunk-bar", oldStart, oldEnd, newStart, newEnd }` で静的表示
- バーには絶対座標 (1-based, inclusive) を持たせて、#540 で「クリックで該当範囲を context 拡張 diff として取り直す」拡張に shape を変えずに対応できるようにする

split view (#540) では同じ hunks を別の `hunksToSplitRows` 系関数に渡せば 4 列構造に再構築できる前提で
view item の生成を関数として独立させている。

## シンタックスハイライト

Shiki の `codeToTokens` で original / current それぞれのトークン配列を取得し、
diff の各行に対応するトークンをマッピングして色付き表示する。
removed 行は original のトークン、added / unchanged 行は current のトークンを使用する。

## 入力契約

`original` / `current` は UTF-8 として解釈可能なテキストである必要がある。NUL バイトを含む
バイナリは PreviewPane 側の `isBinary` 判定で弾かれる前提。万一すり抜けた場合は
Swift 側で `Binary files ... differ` を検知して error にトーストする。

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

/**
 * バーで省略された unchanged 範囲。1-based。
 * unified diff semantics 上、hunk 間 / 末尾 trailing の unchanged 行数は old / new 両側で常に同じ
 * (両側に対応がある context 範囲なので)。この invariant を shape で enforce するため `lines` を 1 本だけ持つ。
 * `oldEnd = oldStart + lines - 1`、`newEnd = newStart + lines - 1` で導出する。
 * #540 のクリック展開で `gitDiffHunks` を `-U N` で取り直す際は `lines` をそのまま渡す。
 */
interface DiffBarItem {
  type: "hunk-bar";
  oldStart: number;
  newStart: number;
  lines: number;
}

type DiffViewItem = DiffLineItem | DiffBarItem;

const notification = useNotificationStore();

const hunks = ref<DiffHunk[]>();
const oldTotalLines = ref(0);
const newTotalLines = ref(0);
const loading = ref(false);
const error = ref<string>();

/**
 * hunk 配列を render 用の view item 列に展開する。
 *
 * - hunk 内の各 line を `DiffLineItem` に変換
 * - 隣接 hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `DiffBarItem` で省略表示
 * - 総行数は Swift 側 (`rpcGitDiffHunks` の oldTotalLines / newTotalLines) を SSOT とし、
 *   renderer 側で `text.split("\n")` を独自に回さない (git の line counting 規約とずれる)
 *
 * #540 で「バーのクリックで該当範囲を context 拡張 diff として取り直す」拡張をする際は
 * `DiffBarItem` の `oldStart`〜`newEnd` 範囲をそのまま渡せる。split view も同じ hunks を別関数で
 * 4 列展開する想定。
 */
function hunksToViewItems(hs: DiffHunk[], oldTotal: number, newTotal: number): DiffViewItem[] {
  const items: DiffViewItem[] = [];
  // 前 hunk の終端 (1-based、未開始は 0)
  let prevOldEnd = 0;
  let prevNewEnd = 0;

  for (const h of hs) {
    const oldGap = h.oldStart - prevOldEnd - 1;
    const newGap = h.newStart - prevNewEnd - 1;
    // unified diff semantics 上 oldGap === newGap が invariant (hunk 間の context は両側同一)。
    // 万一破れた場合は console.error で observable に倒し、表示は max を採用 (silent fallback にしない)
    if (oldGap !== newGap) {
      console.error(
        `[DiffPreview] unified diff invariant violation: oldGap=${oldGap} newGap=${newGap}`,
      );
    }
    const gap = Math.max(oldGap, newGap, 0);
    if (gap > 0) {
      items.push({
        type: "hunk-bar",
        oldStart: prevOldEnd + 1,
        newStart: prevNewEnd + 1,
        lines: gap,
      });
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

  // 最終 hunk 以降の trailing unchanged。両側に同じ数だけ残るのが invariant。
  const oldTrailing = oldTotal - prevOldEnd;
  const newTrailing = newTotal - prevNewEnd;
  if (oldTrailing !== newTrailing) {
    console.error(
      `[DiffPreview] unified diff trailing invariant violation: old=${oldTrailing} new=${newTrailing}`,
    );
  }
  const trailing = Math.max(oldTrailing, newTrailing, 0);
  if (trailing > 0) {
    items.push({
      type: "hunk-bar",
      oldStart: prevOldEnd + 1,
      newStart: prevNewEnd + 1,
      lines: trailing,
    });
  }

  return items;
}

const viewItems = computed<DiffViewItem[]>(() => {
  if (!hunks.value) return [];
  return hunksToViewItems(hunks.value, oldTotalLines.value, newTotalLines.value);
});

watch(
  () => [props.original, props.current] as const,
  async ([original, current], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    loading.value = true;
    error.value = undefined;
    const result = await tryCatch(rpcGitDiffHunks({ original, current }));
    if (cancelled) return;
    loading.value = false;

    if (!result.ok) {
      hunks.value = undefined;
      error.value = result.error.message;
      notification.error("Failed to compute diff", result.error);
      return;
    }
    hunks.value = result.value.hunks;
    oldTotalLines.value = result.value.oldTotalLines;
    newTotalLines.value = result.value.newTotalLines;
  },
  { immediate: true },
);

const lineNoWidth = computed(() => {
  const maxLine = Math.max(oldTotalLines.value, newTotalLines.value, 1);
  return `${String(maxLine).length}ch`;
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

/**
 * 各行を token 配列付きの描画モデルに変換。
 * tokens が undefined のケース: 言語未対応 / token 配列の line index 範囲外。
 * 後者は countDiffLines (Swift) と Shiki の行分割の僅かな差で発生し得るが、
 * template 側 `v-if="row.tokens"` で fallback renderer に倒すため壊れはしない。
 */
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
  return `${item.lines} unchanged line${item.lines === 1 ? "" : "s"}`;
}
</script>

<template>
  <div class="p-4 text-sm/tight" :style="{ '--line-no-width': lineNoWidth }">
    <div v-if="loading && !hunks" class="text-zinc-500">Computing diff...</div>

    <div v-else-if="error" class="text-red-400">Failed to compute diff: {{ error }}</div>

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
