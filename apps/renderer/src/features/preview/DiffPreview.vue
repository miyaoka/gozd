<doc lang="md">
hunk 単位の diff ビュー。unified / split の 2 モードを切り替える。

## 設計

diff 計算は SSOT を git に置き、renderer は `rpcGitDiffHunks` で取得した `hunks` と
`oldTotalLines` / `newTotalLines` を描画するだけ。全文 jsdiff を JS で回すと
大ファイル (`pnpm-lock.yaml` 等) で Myers LCS が O(N×M) で固まるため、
git の C 実装 (xdiff) に処理を委ねる。

## 描画

watch で取得した hunks を `hunksToViewItems` (unified) と `hunksToSplitRows` (split) の
両方に展開し、`baseItems` / `baseSplitItems` として state.success に保持する。
view mode の切り替えで再 fetch は走らない。

### unified

`{ type: "line" | "hunk-bar" }` の列を 1 列レイアウト (old 行番号 / new 行番号 / テキスト) で描画。

### split (default)

`{ type: "split-row" | "hunk-bar" }` の列を 4 列レイアウト (old 行番号 / old テキスト / new 行番号 / new テキスト)
で描画。modified hunk 内では連続する removed run と added run を貪欲ペアリングし、
余った片側は反対セルを空 (灰色背景) にして残す。

### hunk-bar

hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `{ type: "hunk-bar", oldStart, newStart, lines }` で
省略表示。1-based 絶対座標と省略行数を持つ。`oldGap === newGap` が unified diff の invariant なので
`lines` を 1 本に統合してある。invariant が破れた場合は throw し watch 経由で error UI + トーストに倒す。

### バー展開

クリックで `rpcGitDiffExpandLines` を呼び、Swift 側 `countDiffLines` と同じ line counting 規約で
切り出した行ペアを取得して `expansions` Map にキャッシュする。renderer 側で `text.split("\n")` を
回すと CRLF / 末尾改行で Swift と末尾 1 行ずれる (実際の総行数は `oldTotalLines` / `newTotalLines`
の値で、JS の `split("\n").length` とは末尾改行 1 行分異なる) ため、行配列の SSOT も Swift に置く。

## シンタックスハイライト

Shiki の `codeToTokens` で original / current それぞれのトークン配列を取得し、
diff の各行に対応するトークンをマッピングして色付き表示する。
unified では removed 行は original のトークン、added / unchanged 行は current のトークンを使用。
split では左セルが original、右セルが current のトークンを使用する。

## 入力契約

`original` / `current` は UTF-8 として解釈可能なテキストである必要がある。NUL バイトを含む
バイナリは PreviewPane 側の `isBinary` 判定で弾かれる前提。万一すり抜けた場合は
Swift 側で `Binary files ... differ` を検知して error にトーストする。

> [!NOTE]
> 複数行コメントやテンプレートリテラルの開始/終了が変更に含まれる場合、
> unchanged 行でも original と current でトークン結果が異なりうる。
> unified では unchanged を常に current のトークンで描画するため、
> 旧側の文脈との不整合が生じる場合がある。split では左右で別トークンを使うため整合する。
</doc>

<script setup lang="ts">
import { type DiffExpandedLine, type DiffHunk, DiffLineKind } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitDiffExpandLines, rpcGitDiffHunks } from "./rpc";
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
 */
interface DiffBarItem {
  type: "hunk-bar";
  oldStart: number;
  newStart: number;
  lines: number;
}

type DiffViewItem = DiffLineItem | DiffBarItem;

/**
 * split view の 1 行。`oldText` / `newText` のいずれかが undefined の row は modified 行で
 * 片側だけが存在するケース (純粋な add / remove、または run 長が左右で不揃いの余り)。
 * context (両側同じ unchanged 行) は両側に同じテキストと行番号を持つ。
 */
interface DiffSplitRowItem {
  type: "split-row";
  kind: "context" | "modified";
  oldLineNo?: number;
  oldText?: string;
  newLineNo?: number;
  newText?: string;
}

type DiffSplitViewItem = DiffSplitRowItem | DiffBarItem;

type DiffSuccessState = {
  kind: "success";
  baseItems: DiffViewItem[];
  baseSplitItems: DiffSplitViewItem[];
  oldTotal: number;
  newTotal: number;
};

type DiffState = { kind: "loading" } | DiffSuccessState | { kind: "error"; message: string };

const notification = useNotificationStore();
const state = ref<DiffState>({ kind: "loading" });

/**
 * 表示モード。default は split。preview セッションを跨いだ永続化はしない (ローカル state のみ)。
 */
const viewMode = ref<"split" | "unified">("split");

/**
 * 展開済み hunk-bar のキャッシュ。key は `barKey`、value は `rpcGitDiffExpandLines` 結果の行配列。
 * key には oldStart / newStart / lines を全て含めるので、再 fetch で bar 構成が変わった場合は
 * 自動的にキャッシュが効かなくなる (key が一致しないため undefined 扱い)。
 *
 * 行配列のキャッシュ。renderer 側で `text.split("\n")` を回すと CRLF / 末尾改行で
 * Swift 側 `countDiffLines` と末尾 1 行ずれる (countDiffLines は末尾 `\n` ありなら最後の空要素を除外
 * する仕様) ため、行配列の SSOT も Swift に置く。Map の value は `rpcGitDiffExpandLines` の結果。
 */
const expansions = ref<Map<string, DiffExpandedLine[]>>(new Map());

/**
 * 進行中の `rpcGitDiffExpandLines` を持つバー key。同じ key の重複クリックを抑止する。
 * `props.original` / `props.current` の watch でファイル切替時にクリアし、旧ファイル用の
 * in-flight 状態が新ファイル UI に持ち越されないようにする。
 */
const inFlightBars = new Set<string>();

function barKey(bar: DiffBarItem): string {
  return `${bar.oldStart}-${bar.newStart}-${bar.lines}`;
}

/**
 * 1 hunk の lines を unified 行アイテムに展開する。
 */
function expandHunkLinesUnified(h: DiffHunk, items: DiffViewItem[]): void {
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
}

/**
 * 1 hunk の lines を split 行アイテムに展開する。
 * unchanged は両側にテキストを持つ context row、modified 区間は連続する removed run と
 * added run を貪欲にペアリングして同じ row に左右配置する。run 長が不揃いの場合は
 * 余った片側だけの row が並ぶ。
 */
function expandHunkLinesSplit(h: DiffHunk, items: DiffSplitViewItem[]): void {
  let oldLine = h.oldStart;
  let newLine = h.newStart;
  let i = 0;
  while (i < h.lines.length) {
    const line = h.lines[i];
    if (line.kind === DiffLineKind.DIFF_LINE_KIND_CONTEXT) {
      items.push({
        type: "split-row",
        kind: "context",
        oldLineNo: oldLine,
        oldText: line.text,
        newLineNo: newLine,
        newText: line.text,
      });
      oldLine += 1;
      newLine += 1;
      i += 1;
      continue;
    }

    const removeds: { lineNo: number; text: string }[] = [];
    while (i < h.lines.length && h.lines[i].kind === DiffLineKind.DIFF_LINE_KIND_REMOVED) {
      removeds.push({ lineNo: oldLine, text: h.lines[i].text });
      oldLine += 1;
      i += 1;
    }
    const addeds: { lineNo: number; text: string }[] = [];
    while (i < h.lines.length && h.lines[i].kind === DiffLineKind.DIFF_LINE_KIND_ADDED) {
      addeds.push({ lineNo: newLine, text: h.lines[i].text });
      newLine += 1;
      i += 1;
    }
    const pairCount = Math.max(removeds.length, addeds.length);
    for (let j = 0; j < pairCount; j++) {
      const r = removeds[j];
      const a = addeds[j];
      items.push({
        type: "split-row",
        kind: "modified",
        oldLineNo: r?.lineNo,
        oldText: r?.text,
        newLineNo: a?.lineNo,
        newText: a?.text,
      });
    }
  }
}

/**
 * hunks を走査して unified / split の base items を 1 度に組み立てる。
 * hunk 間 / 末尾の連続 unchanged 範囲は `DiffBarItem` で省略する。invariant 違反は throw。
 * 0-line hunk (新規 / 削除ファイル) の扱いは unified / split で同一なので gap 計算をここに集約する。
 */
function buildBaseItems(
  hs: DiffHunk[],
  oldTotal: number,
  newTotal: number,
): { items: DiffViewItem[]; splitItems: DiffSplitViewItem[] } {
  const items: DiffViewItem[] = [];
  const splitItems: DiffSplitViewItem[] = [];
  let prevOldEnd = 0;
  let prevNewEnd = 0;

  for (let idx = 0; idx < hs.length; idx++) {
    const h = hs[idx];
    // 新規ファイル (`@@ -0,0 +A,B @@`) / 削除ファイル (`@@ -X,Y +0,0 @@`) では該当 side の
    // start = 0, lines = 0 になる。この side には gap も末尾も存在しないため、
    // gap 計算ではあたかも `prevEnd + 1` から始まる 0 長 hunk とみなして 0 にする。
    // この正規化を入れないと `0 - 0 - 1 = -1` の負 gap が出て invariant 違反として throw され、
    // 新規ファイル / 削除ファイルの diff プレビューが壊れる。
    const effectiveOldStart = h.oldLines === 0 ? prevOldEnd + 1 : h.oldStart;
    const effectiveNewStart = h.newLines === 0 ? prevNewEnd + 1 : h.newStart;
    const oldGap = effectiveOldStart - prevOldEnd - 1;
    const newGap = effectiveNewStart - prevNewEnd - 1;
    if (oldGap !== newGap) {
      throw new Error(
        `unified diff invariant violation at hunk #${idx}: oldGap=${oldGap} newGap=${newGap} ` +
          `(hunk oldStart=${h.oldStart} oldLines=${h.oldLines} newStart=${h.newStart} ` +
          `newLines=${h.newLines}, after prevOldEnd=${prevOldEnd} prevNewEnd=${prevNewEnd})`,
      );
    }
    if (oldGap > 0) {
      const bar: DiffBarItem = {
        type: "hunk-bar",
        oldStart: prevOldEnd + 1,
        newStart: prevNewEnd + 1,
        lines: oldGap,
      };
      items.push(bar);
      splitItems.push(bar);
    }

    expandHunkLinesUnified(h, items);
    expandHunkLinesSplit(h, splitItems);

    if (h.oldLines > 0) prevOldEnd = h.oldStart + h.oldLines - 1;
    if (h.newLines > 0) prevNewEnd = h.newStart + h.newLines - 1;
  }

  const oldTrailing = oldTotal - prevOldEnd;
  const newTrailing = newTotal - prevNewEnd;
  if (oldTrailing !== newTrailing) {
    throw new Error(
      `unified diff trailing invariant violation: old=${oldTrailing} new=${newTrailing} ` +
        `(oldTotal=${oldTotal} newTotal=${newTotal} prevOldEnd=${prevOldEnd} prevNewEnd=${prevNewEnd}, ` +
        `hunks=${hs.length})`,
    );
  }
  if (oldTrailing > 0) {
    const bar: DiffBarItem = {
      type: "hunk-bar",
      oldStart: prevOldEnd + 1,
      newStart: prevNewEnd + 1,
      lines: oldTrailing,
    };
    items.push(bar);
    splitItems.push(bar);
  }

  return { items, splitItems };
}

watch(
  () => [props.original, props.current] as const,
  async ([original, current], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    state.value = { kind: "loading" };
    expansions.value = new Map();
    inFlightBars.clear();
    const result = await tryCatch(rpcGitDiffHunks({ original, current }));
    if (cancelled) return;

    if (!result.ok) {
      state.value = { kind: "error", message: result.error.message };
      notification.error("Failed to compute diff", result.error);
      return;
    }

    const { hunks, oldTotalLines: oldTotal, newTotalLines: newTotal } = result.value;
    const buildResult = tryCatch(() => buildBaseItems(hunks, oldTotal, newTotal));
    if (!buildResult.ok) {
      state.value = { kind: "error", message: buildResult.error.message };
      notification.error("Diff invariant violation", buildResult.error);
      return;
    }
    state.value = {
      kind: "success",
      baseItems: buildResult.value.items,
      baseSplitItems: buildResult.value.splitItems,
      oldTotal,
      newTotal,
    };
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
    if (cancelled) return;
    if (!result.ok) {
      // `highlightTokens` は言語不明 / 未ロードを undefined で正常返却する (useHighlight.ts)。
      // ここで tryCatch が捕捉するのは Shiki 初期化失敗や予期しない例外で、想定外経路。
      // 描画自体は LINE_FALLBACK_CLASSES で続行できるが、silent に倒すと原因を追えないため
      // error として通知する (renderer 規約: silent fallback 禁止)。
      notification.error("Syntax highlight failed", result.error);
      return;
    }

    const [origTokens, currTokens] = result.value;
    originalTokens.value = origTokens;
    currentTokens.value = currTokens;
  },
  { immediate: true },
);

/** unified の renderRows: 展開済みバーを unchanged 行に置換した後、tokens を埋め込む */
const renderRows = computed(() => {
  if (state.value.kind !== "success") return [];
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  const expandedMap = expansions.value;

  const rendered: ((DiffLineItem & { tokens?: ThemedToken[] }) | DiffBarItem)[] = [];
  for (const item of state.value.baseItems) {
    if (item.type === "hunk-bar") {
      const lines = expandedMap.get(barKey(item));
      if (lines === undefined) {
        rendered.push(item);
        continue;
      }
      for (const ln of lines) {
        rendered.push(
          buildRenderedLine(
            {
              type: "line",
              kind: "unchanged",
              text: ln.newText,
              oldLineNo: ln.oldLineNo,
              newLineNo: ln.newLineNo,
            },
            orig,
            curr,
          ),
        );
      }
      continue;
    }
    rendered.push(buildRenderedLine(item, orig, curr));
  }
  return rendered;
});

function buildRenderedLine(
  item: DiffLineItem,
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
): DiffLineItem & { tokens?: ThemedToken[] } {
  let tokens: ThemedToken[] | undefined;
  if (orig && curr) {
    if (item.kind === "removed" && item.oldLineNo !== undefined) {
      tokens = orig[item.oldLineNo - 1];
    } else if (item.newLineNo !== undefined) {
      tokens = curr[item.newLineNo - 1];
    }
  }
  return { ...item, tokens };
}

/** split の renderRows: 展開済みバーを context row に置換した後、両側のトークンを埋め込む */
const splitRenderRows = computed(() => {
  if (state.value.kind !== "success") return [];
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  const expandedMap = expansions.value;

  type Rendered =
    | (DiffSplitRowItem & { oldTokens?: ThemedToken[]; newTokens?: ThemedToken[] })
    | DiffBarItem;
  const rendered: Rendered[] = [];
  for (const item of state.value.baseSplitItems) {
    if (item.type === "hunk-bar") {
      const lines = expandedMap.get(barKey(item));
      if (lines === undefined) {
        rendered.push(item);
        continue;
      }
      for (const ln of lines) {
        rendered.push(
          buildRenderedSplitRow(
            {
              type: "split-row",
              kind: "context",
              oldLineNo: ln.oldLineNo,
              oldText: ln.oldText,
              newLineNo: ln.newLineNo,
              newText: ln.newText,
            },
            orig,
            curr,
          ),
        );
      }
      continue;
    }
    rendered.push(buildRenderedSplitRow(item, orig, curr));
  }
  return rendered;
});

function buildRenderedSplitRow(
  row: DiffSplitRowItem,
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
): DiffSplitRowItem & { oldTokens?: ThemedToken[]; newTokens?: ThemedToken[] } {
  const oldTokens = orig && row.oldLineNo !== undefined ? orig[row.oldLineNo - 1] : undefined;
  const newTokens = curr && row.newLineNo !== undefined ? curr[row.newLineNo - 1] : undefined;
  return { ...row, oldTokens, newTokens };
}

const tokensReady = computed(
  () => originalTokens.value !== undefined && currentTokens.value !== undefined,
);

function barLabel(item: DiffBarItem): string {
  return `${item.lines} unchanged line${item.lines === 1 ? "" : "s"}`;
}

/**
 * バークリックハンドラ。未展開なら Swift で行範囲を切り出して `expansions` にキャッシュ、
 * 展開済みなら畳む (キャッシュは破棄)。
 *
 * 並行クリックを抑止するため `inFlightBars` で in-flight key を追跡する。同じ key の RPC が
 * 進行中の間は no-op。
 *
 * await 前に `props.original` / `props.current` をキャプチャしておき、await 復帰時に props が
 * 変わっていたら expansions への書き戻しを破棄する。watch 側はファイル切替時に expansions /
 * inFlightBars をクリアするが、RPC が遅延して in-flight のまま新ファイルへ切り替わった場合、
 * 旧ファイル用のレスポンスが新ファイルの `expansions` Map に紛れ込むのを防ぐ必要がある
 * (barKey は oldStart/newStart/lines のみで filePath を識別しないので key 衝突しうる)。
 */
async function toggleBar(bar: DiffBarItem): Promise<void> {
  const key = barKey(bar);
  if (expansions.value.has(key)) {
    const next = new Map(expansions.value);
    next.delete(key);
    expansions.value = next;
    return;
  }
  if (inFlightBars.has(key)) return;
  inFlightBars.add(key);
  const capturedOriginal = props.original;
  const capturedCurrent = props.current;
  const result = await tryCatch(
    rpcGitDiffExpandLines({
      original: capturedOriginal,
      current: capturedCurrent,
      oldStart: bar.oldStart,
      newStart: bar.newStart,
      lines: bar.lines,
    }),
  );
  // await 中にファイル切替が起きていたら破棄。inFlightBars は watch 側で clear 済み。
  if (props.original !== capturedOriginal || props.current !== capturedCurrent) return;
  inFlightBars.delete(key);
  if (!result.ok) {
    notification.error("Failed to expand diff range", result.error);
    return;
  }
  const next = new Map(expansions.value);
  next.set(key, result.value.lines);
  expansions.value = next;
}

/** split row の左セル背景クラス */
function splitLeftBg(row: DiffSplitRowItem): string {
  if (row.kind === "context") return tokensReady.value ? "" : LINE_FALLBACK_CLASSES.unchanged;
  if (row.oldText === undefined) return "_split-filler";
  return tokensReady.value ? LINE_BG_CLASSES.removed : LINE_FALLBACK_CLASSES.removed;
}

/** split row の右セル背景クラス */
function splitRightBg(row: DiffSplitRowItem): string {
  if (row.kind === "context") return tokensReady.value ? "" : LINE_FALLBACK_CLASSES.unchanged;
  if (row.newText === undefined) return "_split-filler";
  return tokensReady.value ? LINE_BG_CLASSES.added : LINE_FALLBACK_CLASSES.added;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- ビューモードトグル -->
    <div
      v-if="state.kind === 'success'"
      class="flex items-center border-b border-zinc-700 px-2 py-1"
    >
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="flex items-center gap-1 px-2 py-0.5 text-xs transition-colors"
          :class="viewMode === 'split' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
          title="Split view"
          aria-label="Split view"
          @click="viewMode = 'split'"
        >
          <span class="icon-[lucide--columns-2] size-3.5" />
          Split
        </button>
        <button
          type="button"
          class="flex items-center gap-1 px-2 py-0.5 text-xs transition-colors"
          :class="viewMode === 'unified' ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
          title="Unified view"
          aria-label="Unified view"
          @click="viewMode = 'unified'"
        >
          <span class="icon-[lucide--align-justify] size-3.5" />
          Unified
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-auto p-4 text-sm/tight" :style="{ '--line-no-width': lineNoWidth }">
      <div v-if="state.kind === 'loading'" class="text-zinc-500">Computing diff...</div>

      <div v-else-if="state.kind === 'error'" class="text-red-400">
        Failed to compute diff: {{ state.message }}
      </div>

      <!-- unified view -->
      <template v-else-if="viewMode === 'unified'">
        <template v-for="(row, i) in renderRows" :key="i">
          <button
            v-if="row.type === 'hunk-bar'"
            type="button"
            class="_hunk-bar"
            :title="`Click to expand ${row.lines} unchanged line${row.lines === 1 ? '' : 's'}`"
            @click="toggleBar(row)"
          >
            <span class="_hunk-bar-icon icon-[lucide--more-horizontal] size-3.5" />
            <span>{{ barLabel(row) }}</span>
          </button>

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

      <!-- split view -->
      <div v-else class="_split-grid">
        <template v-for="(row, i) in splitRenderRows" :key="i">
          <button
            v-if="row.type === 'hunk-bar'"
            type="button"
            class="_hunk-bar _hunk-bar-span"
            :title="`Click to expand ${row.lines} unchanged line${row.lines === 1 ? '' : 's'}`"
            @click="toggleBar(row)"
          >
            <span class="_hunk-bar-icon icon-[lucide--more-horizontal] size-3.5" />
            <span>{{ barLabel(row) }}</span>
          </button>

          <template v-else>
            <span class="_line-no _split-cell" :class="splitLeftBg(row)">{{
              row.oldLineNo ?? ""
            }}</span>
            <span
              class="_line-text _split-cell _split-text"
              :class="[splitLeftBg(row), wordWrap ? '_word-wrap' : '']"
            >
              <template v-if="row.oldText !== undefined">
                <template v-if="row.oldTokens">
                  <span
                    v-for="(token, j) in row.oldTokens"
                    :key="j"
                    :style="token.color ? { color: token.color } : undefined"
                    >{{ token.content }}</span
                  >
                </template>
                <template v-else>{{ row.oldText }}</template>
              </template>
            </span>
            <span class="_line-no _split-cell _split-divider" :class="splitRightBg(row)">{{
              row.newLineNo ?? ""
            }}</span>
            <span
              class="_line-text _split-cell _split-text"
              :class="[splitRightBg(row), wordWrap ? '_word-wrap' : '']"
            >
              <template v-if="row.newText !== undefined">
                <template v-if="row.newTokens">
                  <span
                    v-for="(token, j) in row.newTokens"
                    :key="j"
                    :style="token.color ? { color: token.color } : undefined"
                    >{{ token.content }}</span
                  >
                </template>
                <template v-else>{{ row.newText }}</template>
              </template>
            </span>
          </template>
        </template>
      </div>
    </div>
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
  width: 100%;
  text-align: left;
  cursor: pointer;
}

._hunk-bar:hover {
  background-color: var(--color-zinc-700);
  color: var(--color-zinc-300);
}

._hunk-bar-icon {
  flex-shrink: 0;
}

/* split view: 4-column grid (oldLineNo / oldText / newLineNo / newText) */
._split-grid {
  display: grid;
  grid-template-columns:
    var(--line-no-width, 3ch)
    minmax(0, 1fr)
    var(--line-no-width, 3ch)
    minmax(0, 1fr);
  column-gap: 1.5ch;
  align-items: stretch;
}

._split-cell {
  display: block;
  padding: 0 0.25ch;
}

._split-text {
  padding-left: 0.5ch;
  padding-right: 0.5ch;
}

._split-divider {
  border-left: 1px solid var(--color-zinc-700);
  padding-left: 0.5ch;
}

/* 片側のみの remove / add 行で反対セルを灰色で埋める */
._split-filler {
  background-color: var(--color-zinc-800);
}

._hunk-bar-span {
  grid-column: 1 / -1;
}
</style>
