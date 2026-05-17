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
- hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `{ type: "hunk-bar", oldStart, newStart, lines }` で静的表示
- バーは 1-based 絶対座標 (`oldStart` / `newStart`) と省略行数 (`lines`) を持つ。`oldEnd = oldStart + lines - 1`、`newEnd = newStart + lines - 1` で導出。#540 のクリック展開で `gitDiffHunks` を `-U N` で取り直す際は `lines` をそのまま渡せる
- `oldGap === newGap` が unified diff の invariant なので shape を 1 本の `lines` に統合してある。invariant が破れた場合は `hunksToViewItems` が throw し、watch 経由で error UI + トーストに倒す

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

/**
 * Diff 取得の状態。loading / success / error の 3 状態を discriminated union で表現する。
 * 旧実装は loading / error / hasResult / viewItems の 4 ref で表現していたが、無効状態 (loading=true
 * かつ error 立ち / hasResult=true かつ error 立ち) が型上許され、再 fetch のたびに 4 ref を漏れなく
 * リセットする必要があった。union に集約することで、template 側の `v-if` も `state.kind` で網羅できる。
 * watch は `immediate: true` で初回から `loading` 始まりになるので idle 状態は持たない。
 */
type DiffState =
  | { kind: "loading" }
  | { kind: "success"; items: DiffViewItem[]; oldTotal: number; newTotal: number }
  | { kind: "error"; message: string };

const notification = useNotificationStore();
const state = ref<DiffState>({ kind: "loading" });

/**
 * hunk 配列を render 用の view item 列に展開する。pure (例外送出を除き副作用なし)。
 *
 * - hunk 内の各 line を `DiffLineItem` に変換
 * - 隣接 hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `DiffBarItem` で省略表示
 * - 総行数は Swift 側 (`rpcGitDiffHunks` の oldTotalLines / newTotalLines) を SSOT とし、
 *   renderer 側で `text.split("\n")` を独自に回さない (git の line counting 規約とずれる)
 * - unified diff の invariant (hunk 間 / trailing の unchanged 行数は old / new 両側で一致) が
 *   破れた場合は `Error` を throw する。CLAUDE.md の「fallback せずエラーにする」規律に従い、
 *   `Math.max` で取り繕って描画する fallback は持たせない。呼び出し側は `tryCatch` で error UI に倒す
 *
 * #540 で「バーのクリックで該当範囲を context 拡張 diff として取り直す」拡張をする際は
 * `DiffBarItem` の `{ oldStart, newStart, lines }` をそのまま渡せる。split view も同じ hunks を
 * 別関数で 4 列展開する想定。
 */
function hunksToViewItems(hs: DiffHunk[], oldTotal: number, newTotal: number): DiffViewItem[] {
  const items: DiffViewItem[] = [];
  // 前 hunk の終端 (1-based、未開始は 0)
  let prevOldEnd = 0;
  let prevNewEnd = 0;

  for (const h of hs) {
    // unified diff の `@@ -0,0 +A,B @@` (新規ファイル) や `@@ -X,Y +0,0 @@` (削除ファイル) では
    // 該当 side の start = 0, lines = 0 になる。この side には gap も末尾も存在しないため、
    // gap 計算ではあたかも `prevEnd + 1` から始まる 0 長 hunk とみなして 0 にする。
    // この正規化を入れないと `0 - 0 - 1 = -1` の負 gap が出て、invariant 違反として throw される
    // (新規ファイル / 削除ファイルの diff プレビューが壊れる)。
    const effectiveOldStart = h.oldLines === 0 ? prevOldEnd + 1 : h.oldStart;
    const effectiveNewStart = h.newLines === 0 ? prevNewEnd + 1 : h.newStart;
    const oldGap = effectiveOldStart - prevOldEnd - 1;
    const newGap = effectiveNewStart - prevNewEnd - 1;
    if (oldGap !== newGap) {
      throw new Error(
        `unified diff invariant violation between hunks: oldGap=${oldGap} newGap=${newGap}`,
      );
    }
    if (oldGap > 0) {
      items.push({
        type: "hunk-bar",
        oldStart: prevOldEnd + 1,
        newStart: prevNewEnd + 1,
        lines: oldGap,
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
    // 0-line side では prevEnd を更新しない (`oldStart + oldLines - 1 = -1` になるため)。
    if (h.oldLines > 0) prevOldEnd = h.oldStart + h.oldLines - 1;
    if (h.newLines > 0) prevNewEnd = h.newStart + h.newLines - 1;
  }

  const oldTrailing = oldTotal - prevOldEnd;
  const newTrailing = newTotal - prevNewEnd;
  if (oldTrailing !== newTrailing) {
    throw new Error(
      `unified diff trailing invariant violation: old=${oldTrailing} new=${newTrailing}`,
    );
  }
  if (oldTrailing > 0) {
    items.push({
      type: "hunk-bar",
      oldStart: prevOldEnd + 1,
      newStart: prevNewEnd + 1,
      lines: oldTrailing,
    });
  }

  return items;
}

watch(
  () => [props.original, props.current] as const,
  async ([original, current], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    state.value = { kind: "loading" };
    const result = await tryCatch(rpcGitDiffHunks({ original, current }));
    if (cancelled) return;

    if (!result.ok) {
      state.value = { kind: "error", message: result.error.message };
      notification.error("Failed to compute diff", result.error);
      return;
    }

    const { hunks, oldTotalLines: oldTotal, newTotalLines: newTotal } = result.value;
    const buildResult = tryCatch(() => hunksToViewItems(hunks, oldTotal, newTotal));
    if (!buildResult.ok) {
      state.value = { kind: "error", message: buildResult.error.message };
      notification.error("Diff invariant violation", buildResult.error);
      return;
    }
    state.value = { kind: "success", items: buildResult.value, oldTotal, newTotal };
  },
  { immediate: true },
);

const lineNoWidth = computed(() => {
  const s = state.value;
  if (s.kind !== "success") return "1ch";
  const maxLine = Math.max(s.oldTotal, s.newTotal, 1);
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
  if (state.value.kind !== "success") return [];
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  return state.value.items.map((item) => {
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
    <div v-if="state.kind === 'loading'" class="text-zinc-500">Computing diff...</div>

    <div v-else-if="state.kind === 'error'" class="text-red-400">
      Failed to compute diff: {{ state.message }}
    </div>

    <template v-else-if="state.kind === 'success'">
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
