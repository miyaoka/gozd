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

### section 分割と選択スコープ

`renderRows` / `splitRenderRows` を hunk-bar 境界で section (連続する非 hunk-bar 行 1 群)
に分割し、各 section を `contenteditable=true` の editing host にする。hunk-bar は
section の外に sibling として置くため Cmd+A の scope に入らず、unchanged lines のラベルは
clipboard に乗らない。行番号は `::before { content: attr(data-line-no) }` の generated
content なので構造的に clipboard 対象外。

### unified

各 section が `_unified-section` 1 つの contenteditable コンテナ。section 内で各行を
`display: block` の `_diff-line` として並べ、line-no を `inline-block`、本文を `inline`
の hanging indent (`padding-left` + 負 `text-indent`) で配置する。flex / grid を経由しないので
子要素の blockification が起きず、contenteditable コピー時に「1 行 = 1 改行」になる。

### split (default)

各 section が `_split-section` の `1fr 1fr` grid で 2 半身 (left / right) を並べ、
半身それぞれが独立した contenteditable host (sibling)。Cmd+A の scope は focus が居る
半身 1 つだけに閉じる。半身内は per-row の `_split-row` を 1 つ 1 block として並べ、
hanging indent (`padding-left` + 負 `text-indent`) で line-no と本文を配置する。
行揃えは CSS subgrid で実現する: `_split-section` に `grid-template-rows: repeat(N, auto)`
を style binding で渡し、両半身が `grid-template-rows: subgrid` で同じ row track を
継承する。これで word-wrap で左右の折返し行数が違っても、行ごとに高い方に track が伸びて
左 row j と右 row j が同じ親 track に置かれ、左右の行が縦に揃う。
modified hunk 内では連続する removed run と added run を貪欲ペアリングし、片側だけが
存在する行は反対側の `_split-row` を空 (`_split-filler` で灰色背景) にして残す。

### hunk-bar

hunk 間 / ファイル先頭・末尾の連続 unchanged 範囲は `{ type: "hunk-bar", oldStart, newStart, lines }` で
省略表示。1-based 絶対座標と省略行数を持つ。`oldGap === newGap` が unified diff の invariant なので
`lines` を 1 本に統合してある。invariant が破れた場合は throw し watch 経由で error UI + トーストに倒す。

### バー展開

クリックで `rpcGitDiffExpandLines` を呼び、main 側 `countDiffLines` と同じ line counting 規約で
切り出した行ペアを取得して `expansions` Map にキャッシュする。renderer 側で `text.split("\n")` を
回すと CRLF / 末尾改行で main 側と末尾 1 行ずれる (実際の総行数は `oldTotalLines` / `newTotalLines`
の値で、JS の `split("\n").length` とは末尾改行 1 行分異なる) ため、行配列の SSOT も main に置く。

## シンタックスハイライト

Shiki の `codeToTokens` で original / current それぞれのトークン配列を取得し、
diff の各行に対応するトークンをマッピングして色付き表示する。
unified では removed 行は original のトークン、added / unchanged 行は current のトークンを使用。
split では左セルが original、右セルが current のトークンを使用する。

## 入力契約

`original` / `current` は UTF-8 として解釈可能なテキストである必要がある。NUL バイトを含む
バイナリは PreviewPane 側の `isBinary` 判定で弾かれる前提。万一すり抜けた場合は
main 側で `Binary files ... differ` を検知して error にトーストする。

> [!NOTE]
> 複数行コメントやテンプレートリテラルの開始/終了が変更に含まれる場合、
> unchanged 行でも original と current でトークン結果が異なりうる。
> unified では unchanged を常に current のトークンで描画するため、
> 旧側の文脈との不整合が生じる場合がある。split では左右で別トークンを使うため整合する。

## 編集モード (`editable` prop)

上記の自前 hunk 描画 (contenteditable + Shiki トークン) とは完全に別の描画パス。Monaco Editor
(`monacoSetup.ts`) の `createDiffEditor` をそのままマウントし、シンタックスハイライトを保った
まま original (readonly) / modified (editable) を左右比較できるようにする。理由:

- Shiki トークンの `v-for` を直接 contenteditable にすると、入力のたびに token 構造が壊れる上、
  次の Vue 再レンダリングで実 DOM がユーザーの編集を上書きしてしまう
- VSCode / Monaco は hidden `<textarea>` + 独自テキストモデルで入力と描画を分離する設計だが、
  これを自前実装するのは車輪の再発明。同ジャンルの実プロダクト (stablyai/orca) も `monaco-editor`
  をそのまま採用しているため、gozd でも同じ選択をする

diff 計算は Monaco 自身の内蔵アルゴリズムに委ねる (read-only 表示は git 由来の SSOT を保つ設計の
ままだが、編集専用のこのパスだけは Monaco の diff 計算に委譲するトレードオフを取る)。
`hideUnchangedRegions` で unchanged 領域の折り畳みも Monaco 標準機能に任せるため、read-only 側の
hunk-bar 展開のような処理はここでは不要。unified view は非対応で editable 中は split 固定。

`monaco-editor` は全言語入りの重量パッケージのため、`editable` が true になったタイミングで
`import("./monacoSetup")` して遅延ロードする (CodeEditor.vue と同じ契約)。read-only 表示のみの
利用者 (ChangesSummaryView 等、他の DiffPreview 利用箇所を含む) はロードしない。

編集内容の SSOT は usePreviewEditStore の draftContent。Monaco の modified model が変わるたびに
`update:modelValue` を emit し (CodeEditor.vue と同じ契約)、親 (PreviewPane) が
`editStore.updateDraft` に渡す。dirty 判定もこの draftContent の比較に一本化されており、
DiffPreview / useDiffEditor は独自の dirty state を持たない。
</doc>

<script setup lang="ts">
import type { DiffExpandedLine, DiffHunk } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import type * as Monaco from "monaco-editor";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitDiffExpandLines, rpcGitDiffHunks } from "./rpc";
import { useDiffEditor } from "./useDiffEditor";
import { type ThemedToken, highlightTokens } from "./useHighlight";
import IconLucideAlignJustify from "~icons/lucide/align-justify";
import IconLucideColumns2 from "~icons/lucide/columns-2";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";

const props = withDefaults(
  defineProps<{
    original: string;
    current: string;
    filePath: string;
    wordWrap: boolean;
    /**
     * 外部から viewMode を制御する場合に指定する。
     * 指定時は内部の split/unified トグルバーを非表示にする (親側で 1 つの toolbar に統合する用途)。
     * 未指定なら内部 ref で split/unified をローカル管理し、トグルバーも自分で描画する。
     */
    externalViewMode?: "split" | "unified";
    /**
     * 行番号を blame ボタンとして描画するか。false なら静的な行番号セルに倒し、
     * hover も cursor:pointer も出さない (silent dead button 禁止規約)。
     */
    blameEnabled?: boolean;
    /**
     * true のとき右半身 (current 側) を編集可能にする。左半身 (original) は常に read-only。
     * unified view には対応しないため editable 中は split view に固定し、トグルを隠す。
     */
    editable?: boolean;
  }>(),
  { externalViewMode: undefined, blameEnabled: false, editable: false },
);

/**
 * 行番号クリック。side で original / current のどちら側の rev を blame するかを区別する。
 * - "old" → row.oldLineNo の行番号で original (= 比較元 rev) を blame
 * - "new" → row.newLineNo の行番号で current (= 比較先 rev / working tree) を blame
 */
const emit = defineEmits<{
  lineNumberClick: [payload: { side: "old" | "new"; line: number; anchorEl: HTMLElement }];
  /** 編集モード中の ESC (他 widget が開いていないとき)。PreviewPane が編集キャンセルにバインドする */
  cancel: [];
  /** 編集モード中、Monaco modified model の内容が変わるたびに発火 (CodeEditor.vue と同じ契約) */
  "update:modelValue": [value: string];
}>();

function onLineClick(side: "old" | "new", line: number, ev: MouseEvent): void {
  if (!props.blameEnabled) return;
  const target = ev.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  emit("lineNumberClick", { side, line, anchorEl: target });
}

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
 * `externalViewMode` prop が指定された場合はそちらを優先する (summary view から束ねるケース)。
 */
const internalViewMode = ref<"split" | "unified">("split");
const viewMode = computed(() => props.externalViewMode ?? internalViewMode.value);

/**
 * 展開済み hunk-bar のキャッシュ。key は `barKey`、value は `rpcGitDiffExpandLines` 結果の行配列。
 * key には oldStart / newStart / lines を全て含めるので、再 fetch で bar 構成が変わった場合は
 * 自動的にキャッシュが効かなくなる (key が一致しないため undefined 扱い)。
 *
 * 行配列のキャッシュ。renderer 側で `text.split("\n")` を回すと CRLF / 末尾改行で
 * main 側 `countDiffLines` と末尾 1 行ずれる (countDiffLines は末尾 `\n` ありなら最後の空要素を除外
 * する仕様) ため、行配列の SSOT も main に置く。Map の value は `rpcGitDiffExpandLines` の結果。
 */
const expansions = ref<Map<string, DiffExpandedLine[]>>(new Map());

/**
 * 進行中の `rpcGitDiffExpandLines` を持つバー key。同じ key の重複クリックを抑止する。
 * `props.original` / `props.current` の watch でファイル切替時にクリアし、旧ファイル用の
 * in-flight 状態が新ファイル UI に持ち越されないようにする。
 *
 * non-reactive (`ref` で囲まない): UI からは参照せず、抑止用の boolean state としてだけ使う。
 * もし template から「展開中インジケータ」を表示する要件が出たら、その時点で
 * `ref<Set<string>>` に昇格して reactivity を持たせる。
 */
const inFlightBars = new Set<string>();

/**
 * 現在の diff ロードを識別する token。watch ハンドラ開始時に新しい Symbol を発行する。
 * `toggleBar` は await 前にこの token をキャプチャし、await 復帰時に token が変わっていたら
 * 結果を破棄する。`props.original` の参照同一性に依存しないため、上流 (PreviewPane) が
 * 同じファイルに同じ string インスタンスを再供給するように最適化されても安全。
 *
 * `inFlightBars` と同じく non-reactive。UI から参照せず watch / computed の依存にも入れないため
 * `ref` で囲む必要がない。Symbol は常に unique なので description 文字列は省略する。
 */
let loadToken: symbol = Symbol();

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
    if (line.kind === "removed") {
      items.push({ type: "line", kind: "removed", text: line.text, oldLineNo: oldLine });
      oldLine += 1;
    } else if (line.kind === "added") {
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
    if (line.kind === "context") {
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
    while (i < h.lines.length && h.lines[i].kind === "removed") {
      removeds.push({ lineNo: oldLine, text: h.lines[i].text });
      oldLine += 1;
      i += 1;
    }
    const addeds: { lineNo: number; text: string }[] = [];
    while (i < h.lines.length && h.lines[i].kind === "added") {
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
    loadToken = Symbol();
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
  added: "bg-success-subtle",
  removed: "bg-destructive-subtle",
  unchanged: "",
};

const LINE_FALLBACK_CLASSES: Record<DiffLineKindName, string> = {
  added: "text-success-text bg-success-subtle",
  removed: "text-destructive-text bg-destructive-subtle",
  unchanged: "text-foreground",
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

/**
 * Cmd+A scope を「開かれている可視チャンク 1 つ」に閉じ込めるため、`renderRows` /
 * `splitRenderRows` を hunk-bar 境界で section に分割する。section が contenteditable
 * の editing host になり、hunk-bar 自体は contenteditable の **外** に sibling として
 * 置く構造に template 側を組む。
 *
 * 配列要素は `DiffBarItem` か `{ type: "section"; lines: ... }` のどちらかで、
 * 並び順が DOM 描画順と一致する。hunk-bar の前後関係 / 末尾 trailing は flat 配列に
 * そのまま現れるため、template の v-for 1 段で素直に描ける。
 */
type RenderedUnifiedLine = DiffLineItem & { tokens?: ThemedToken[] };
type RenderedSplitLine = DiffSplitRowItem & {
  oldTokens?: ThemedToken[];
  newTokens?: ThemedToken[];
};
type UnifiedItem = DiffBarItem | { type: "section"; lines: RenderedUnifiedLine[] };
type SplitItem = DiffBarItem | { type: "section"; lines: RenderedSplitLine[] };

const unifiedItems = computed<UnifiedItem[]>(() => {
  const out: UnifiedItem[] = [];
  let current: RenderedUnifiedLine[] = [];
  for (const row of renderRows.value) {
    if (row.type === "hunk-bar") {
      if (current.length > 0) {
        out.push({ type: "section", lines: current });
        current = [];
      }
      out.push(row);
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) out.push({ type: "section", lines: current });
  return out;
});

const splitItems = computed<SplitItem[]>(() => {
  const out: SplitItem[] = [];
  let current: RenderedSplitLine[] = [];
  for (const row of splitRenderRows.value) {
    if (row.type === "hunk-bar") {
      if (current.length > 0) {
        out.push({ type: "section", lines: current });
        current = [];
      }
      out.push(row);
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) out.push({ type: "section", lines: current });
  return out;
});

const tokensReady = computed(
  () => originalTokens.value !== undefined && currentTokens.value !== undefined,
);

function barLabel(item: DiffBarItem): string {
  return `${item.lines} unchanged line${item.lines === 1 ? "" : "s"}`;
}

/**
 * バークリックハンドラ。未展開なら main 側で行範囲を切り出して `expansions` にキャッシュ、
 * 展開済みなら畳む (キャッシュは破棄)。
 *
 * 並行クリックを抑止するため `inFlightBars` で in-flight key を追跡する。同じ key の RPC が
 * 進行中の間は no-op。
 *
 * `loadToken` を await 前にキャプチャしておき、await 復帰時に token が変わっていたら結果を破棄する。
 * これにより RPC が遅延して in-flight のまま新ファイルへ切り替わった場合に、旧ファイル用の
 * レスポンスが新ファイルの `expansions` Map に紛れ込むのを防ぐ (barKey は oldStart/newStart/lines
 * のみで識別するため、異なるファイルでも key 衝突しうる)。
 *
 * `inFlightBars.delete` は token 判定の前に呼ぶ。watch 側 clear と二重に走っても Set.delete は
 * idempotent なので問題なく、対称性が崩れない (add と必ず対になる)。
 */
/** バーを RPC で展開して `expansions` に格納する (既展開ならフェッチしない)。toggleBar / expandAllBars 共有。 */
async function fetchBarLines(bar: DiffBarItem): Promise<void> {
  const key = barKey(bar);
  if (expansions.value.has(key)) return;
  if (inFlightBars.has(key)) return;
  inFlightBars.add(key);
  const myToken = loadToken;
  const result = await tryCatch(
    rpcGitDiffExpandLines({
      original: props.original,
      current: props.current,
      oldStart: bar.oldStart,
      newStart: bar.newStart,
      lines: bar.lines,
    }),
  );
  inFlightBars.delete(key);
  if (loadToken !== myToken) return;
  if (!result.ok) {
    notification.error("Failed to expand diff range", result.error);
    return;
  }
  const next = new Map(expansions.value);
  next.set(key, result.value.lines);
  expansions.value = next;
}

async function toggleBar(bar: DiffBarItem): Promise<void> {
  const key = barKey(bar);
  if (expansions.value.has(key)) {
    const next = new Map(expansions.value);
    next.delete(key);
    expansions.value = next;
    return;
  }
  await fetchBarLines(bar);
}

/**
 * 編集モード。Monaco の `createDiffEditor` (シンタックスハイライト付き diff editor 標準機能) を
 * 丸ごとマウントし、read-only 表示 (自前 hunk 描画、上記 unified/split ロジック) とは完全に別の
 * 描画パスにする。original は常に readonly、modified (= current) のみ編集可能にする。
 *
 * diff 計算は Monaco 自身の内蔵アルゴリズムに委ねる (read-only 表示は git 由来の SSOT を保つ設計
 * のままだが、編集専用のこのパスだけは Monaco の diff 計算に委譲するトレードオフを取る。
 * `hideUnchangedRegions` で unchanged 領域の折り畳みも Monaco 標準機能に任せるため、read-only
 * 側にあった hunk-bar 展開 (`expandAllBars` 相当) はここでは不要)。
 */
const monacoContainerRef = ref<HTMLElement>();
let monacoDiffEditor: Monaco.editor.IStandaloneDiffEditor | undefined;

/**
 * `monaco-editor` は全言語入りの重量パッケージ (`monacoSetup.ts` 参照) のため、編集モード突入時
 * (この関数の呼び出しタイミング) まで `import("./monacoSetup")` で遅延ロードする。
 */
let mountGeneration = 0;
async function mountMonacoDiffEditor() {
  const el = monacoContainerRef.value;
  // unmount 済みの template ref は Vue により null に戻る (undefined は初期値のみ)。
  // reset() (781 行目付近) の null チェックと対称に揃える。
  if (!el) return;
  const myGeneration = ++mountGeneration;
  const { monaco, detectMonacoLanguage } = await import("./monacoSetup");
  // await 中に editable の再トグル / unmount が起きた場合は何もしない (世代不一致で判定)。
  if (myGeneration !== mountGeneration || monacoContainerRef.value !== el || !props.editable) {
    return;
  }
  const language = detectMonacoLanguage(props.filePath);
  const originalModel = monaco.editor.createModel(props.original, language);
  const modifiedModel = monaco.editor.createModel(props.current, language);
  monacoDiffEditor = monaco.editor.createDiffEditor(el, {
    originalEditable: false,
    readOnly: false,
    renderSideBySide: true,
    automaticLayout: true,
    theme: "vs-dark",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    hideUnchangedRegions: { enabled: true },
    wordWrap: props.wordWrap ? "on" : "off",
  });
  monacoDiffEditor.setModel({ original: originalModel, modified: modifiedModel });
  const modifiedEditor = monacoDiffEditor.getModifiedEditor();
  // MainLayout のグローバル ESC (preview を閉じる) は e.defaultPrevented を見て早期 return する。
  // CodeEditor.vue と同じ契約: 他 widget が開いていないときだけ「編集キャンセル」に倒す。
  modifiedEditor.addCommand(
    monaco.KeyCode.Escape,
    () => emit("cancel"),
    "!suggestWidgetVisible && !findWidgetVisible && !renameInputVisible",
  );
  // reset() (Discard) 実行中は setValue が発火させる onDidChangeModelContent を無視する。
  // 無視しないと、editStore.discard() で既に draftContent = savedContent 済みの内容を
  // 同じ値で emit するだけの無駄な updateDraft が走る (実害は無いが抑止しておく)。
  let suppressChange = false;
  // 編集内容の SSOT は editStore.draftContent (CodeEditor.vue と同じ契約)。ここでは
  // Monaco の変更を親 (PreviewPane) に伝播するだけで、dirty 判定は持たない。
  modifiedEditor.onDidChangeModelContent(() => {
    if (suppressChange) return;
    emit("update:modelValue", modifiedEditor?.getValue() ?? "");
  });
  diffEditor.register({
    reset: (content: string) => {
      const model = monacoDiffEditor?.getModifiedEditor().getModel();
      if (model === undefined || model === null) return;
      suppressChange = true;
      model.setValue(content);
      suppressChange = false;
    },
  });
}

function unmountMonacoDiffEditor() {
  mountGeneration++; // in-flight な mountMonacoDiffEditor (dynamic import 待ち) を無効化する
  const model = monacoDiffEditor?.getModel();
  model?.original.dispose();
  model?.modified.dispose();
  monacoDiffEditor?.dispose();
  monacoDiffEditor = undefined;
  diffEditor.unregister();
}

const diffEditor = useDiffEditor();

watch(
  () => props.editable,
  (editable) => {
    if (!editable) {
      unmountMonacoDiffEditor();
      return;
    }
    // unified view には対応しないため split に固定する。
    internalViewMode.value = "split";
    void nextTick(mountMonacoDiffEditor);
  },
  { immediate: true },
);

watch(
  () => props.wordWrap,
  (wrap) => {
    monacoDiffEditor?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  },
);

onUnmounted(() => {
  unmountMonacoDiffEditor();
});

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

/**
 * contenteditable host の編集経路を構造的にブロックする。`beforeinput` で
 * `event.preventDefault()` すれば typing / paste / IME / undo-redo / drop の DOM mutation を
 * 1 経路で止められる (input 系全部の上位 hook)。
 *
 * テンプレート側では各 contenteditable host に `@beforeinput="blockEdit"` に加えて
 * `@dragover.prevent @drop.prevent` も付けている。`beforeinput` だけでも drop の DOM mutation
 * は弾けるが、`dragover` を preventDefault しないと UA がドロップ可能 cursor / drop indicator を
 * 一瞬表示してチラ見せが起きる経路があり、UX 上の保険として両方つける契約。
 */
function blockEdit(event: Event) {
  event.preventDefault();
}
</script>

<template>
  <!--
    編集モード: 自前 hunk 描画とは完全に別の描画パス。Monaco の createDiffEditor をそのまま
    マウントするだけのコンテナ (script 側の mountMonacoDiffEditor 参照)。
  -->
  <div v-if="editable" ref="monacoContainerRef" class="size-full" />

  <div v-else class="flex h-full flex-col">
    <!-- ビューモードトグル (externalViewMode 指定時は親側で 1 本に統合) -->
    <div
      v-if="state.kind === 'success' && externalViewMode === undefined"
      class="flex items-center border-b border-border px-2 py-1"
    >
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="flex items-center gap-1 px-2 py-0.5 text-xs transition-colors"
          :class="
            viewMode === 'split' ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
          "
          title="Split view"
          aria-label="Split view"
          @click="internalViewMode = 'split'"
        >
          <IconLucideColumns2 class="size-3.5" />
          Split
        </button>
        <button
          type="button"
          class="flex items-center gap-1 px-2 py-0.5 text-xs transition-colors"
          :class="
            viewMode === 'unified'
              ? 'text-primary-text'
              : 'text-foreground-low hover:text-foreground'
          "
          title="Unified view"
          aria-label="Unified view"
          @click="internalViewMode = 'unified'"
        >
          <IconLucideAlignJustify class="size-3.5" />
          Unified
        </button>
      </div>
    </div>

    <!--
      diff 本体 scroll コンテナ。contenteditable は **section (= hunk-bar で挟まれた可視チャンク) 単位**
      の host で、scroll コンテナ自体は host にしない。hunk-bar は section の **外** に sibling として
      置くため、Cmd+A は focus が居る section だけに閉じ、hunk-bar / 他 section は scope に入らない。
    -->
    <div
      class="_diff-scroll flex-1 overflow-auto p-4 text-sm/tight"
      :style="{ '--line-no-width': lineNoWidth }"
    >
      <div v-if="state.kind === 'loading'" class="text-foreground-low">Computing diff...</div>

      <div v-else-if="state.kind === 'error'" class="text-destructive-text">
        Failed to compute diff: {{ state.message }}
      </div>

      <!-- unified view: section ごとに contenteditable 1 つ。hunk-bar は sibling。 -->
      <template v-else-if="viewMode === 'unified'">
        <template v-for="(item, i) in unifiedItems" :key="i">
          <button
            v-if="item.type === 'hunk-bar'"
            type="button"
            class="_hunk-bar"
            :title="`Click to expand ${item.lines} unchanged line${item.lines === 1 ? '' : 's'}`"
            @click="toggleBar(item)"
          >
            <IconLucideMoreHorizontal class="_hunk-bar-icon size-3.5" />
            <span>{{ barLabel(item) }}</span>
          </button>

          <div
            v-else
            class="_unified-section"
            contenteditable="true"
            spellcheck="false"
            autocorrect="off"
            autocapitalize="off"
            role="region"
            aria-label="Diff section"
            @beforeinput="blockEdit"
            @dragover.prevent
            @drop.prevent
          >
            <div
              v-for="(row, j) in item.lines"
              :key="j"
              class="_diff-line"
              :class="tokensReady ? LINE_BG_CLASSES[row.kind] : LINE_FALLBACK_CLASSES[row.kind]"
            >
              <button
                v-if="row.oldLineNo !== undefined && blameEnabled"
                type="button"
                class="_line-no _line-no-btn"
                :data-line-no="row.oldLineNo"
                :aria-label="`Old line ${row.oldLineNo}`"
                @click="onLineClick('old', row.oldLineNo, $event)"
              />
              <span
                v-else
                class="_line-no"
                :data-line-no="row.oldLineNo ?? ''"
                aria-hidden="true"
              />
              <button
                v-if="row.newLineNo !== undefined && blameEnabled"
                type="button"
                class="_line-no _line-no-btn"
                :data-line-no="row.newLineNo"
                :aria-label="`New line ${row.newLineNo}`"
                @click="onLineClick('new', row.newLineNo, $event)"
              />
              <span
                v-else
                class="_line-no"
                :data-line-no="row.newLineNo ?? ''"
                aria-hidden="true"
              />
              <span class="_line-text" :class="wordWrap ? '_word-wrap' : ''">
                <template v-if="row.tokens">
                  <span
                    v-for="(token, k) in row.tokens"
                    :key="k"
                    :style="token.color ? { color: token.color } : undefined"
                    >{{ token.content }}</span
                  >
                </template>
                <template v-else>{{ row.text }}</template>
              </span>
            </div>
          </div>
        </template>
      </template>

      <!--
        split view: section ごとに「左半身 contenteditable」+「右半身 contenteditable」の sibling 構成。
        hunk-bar は section の外に sibling として置くので scope に入らない。
        section 内の左右行揃えは CSS subgrid で実現する。`_split-section` に
        `grid-template-rows: repeat(N, auto)` を style binding で渡し、両半身が
        `grid-template-rows: subgrid` で同じ N 個の row track を共有する。これで
        word-wrap で左右の折返し行数が違っても、行ごとに高い方に track が伸びて
        左 row j と右 row j が同じ親 track に置かれる。
      -->
      <template v-else>
        <template v-for="(item, i) in splitItems" :key="i">
          <button
            v-if="item.type === 'hunk-bar'"
            type="button"
            class="_hunk-bar"
            :title="`Click to expand ${item.lines} unchanged line${item.lines === 1 ? '' : 's'}`"
            @click="toggleBar(item)"
          >
            <IconLucideMoreHorizontal class="_hunk-bar-icon size-3.5" />
            <span>{{ barLabel(item) }}</span>
          </button>

          <div
            v-else
            class="_split-section"
            :style="{ gridTemplateRows: `repeat(${item.lines.length}, auto)` }"
          >
            <div
              class="_split-half _split-half-left"
              contenteditable="true"
              spellcheck="false"
              autocorrect="off"
              autocapitalize="off"
              role="region"
              aria-label="Old contents"
              @beforeinput="blockEdit"
              @dragover.prevent
              @drop.prevent
            >
              <div
                v-for="(row, j) in item.lines"
                :key="`L${j}`"
                class="_split-row"
                :class="splitLeftBg(row)"
              >
                <button
                  v-if="row.oldLineNo !== undefined && blameEnabled"
                  type="button"
                  class="_line-no _line-no-btn"
                  :data-line-no="row.oldLineNo"
                  :aria-label="`Old line ${row.oldLineNo}`"
                  @click="onLineClick('old', row.oldLineNo, $event)"
                />
                <span
                  v-else
                  class="_line-no"
                  :data-line-no="row.oldLineNo ?? ''"
                  aria-hidden="true"
                />
                <span class="_line-text" :class="wordWrap ? '_word-wrap' : ''">
                  <template v-if="row.oldText !== undefined">
                    <template v-if="row.oldTokens">
                      <span
                        v-for="(token, k) in row.oldTokens"
                        :key="k"
                        :style="token.color ? { color: token.color } : undefined"
                        >{{ token.content }}</span
                      >
                    </template>
                    <template v-else>{{ row.oldText }}</template>
                  </template>
                </span>
              </div>
            </div>

            <div
              class="_split-half _split-half-right"
              contenteditable="true"
              spellcheck="false"
              autocorrect="off"
              autocapitalize="off"
              role="region"
              aria-label="New contents"
              @beforeinput="blockEdit"
              @dragover.prevent
              @drop.prevent
            >
              <div
                v-for="(row, j) in item.lines"
                :key="`R${j}`"
                class="_split-row"
                :class="splitRightBg(row)"
              >
                <button
                  v-if="row.newLineNo !== undefined && blameEnabled"
                  type="button"
                  class="_line-no _line-no-btn"
                  :data-line-no="row.newLineNo"
                  :aria-label="`New line ${row.newLineNo}`"
                  @click="onLineClick('new', row.newLineNo, $event)"
                />
                <span
                  v-else
                  class="_line-no"
                  :data-line-no="row.newLineNo ?? ''"
                  aria-hidden="true"
                />
                <span class="_line-text" :class="wordWrap ? '_word-wrap' : ''">
                  <template v-if="row.newText !== undefined">
                    <template v-if="row.newTokens">
                      <span
                        v-for="(token, k) in row.newTokens"
                        :key="k"
                        :style="token.color ? { color: token.color } : undefined"
                        >{{ token.content }}</span
                      >
                    </template>
                    <template v-else>{{ row.newText }}</template>
                  </template>
                </span>
              </div>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* diff 本文は clipboard 制御のため pre/code を使わない div 描画 (下記 `_diff-line` コメント参照) で、
   main.css @layer base の `pre, code` コードフォント規則が届かない。同じ var 連鎖を
   ここで参照し、コードフォントの解決 (設定値 → --font-mono fallback) を pre/code 面と揃える。 */
._diff-scroll {
  font-family: var(--preview-code-font-family, var(--font-mono));
}

/* 1 diff 行を 1 block に揃えて clipboard の `\n` を 1 行につき 1 個にする。
   `display: flex` で子要素を blockification すると、contenteditable コピー時に各子の block
   境界でも `\n` が入り、行間に空行が混じる現象になる。block + inline-block + 負 text-indent
   の hanging indent パターンに倒すことで、word-wrap モードでも折返し行が line-no 幅で
   indent 揃えされる挙動を保ったまま、clipboard を 1 行 = 1 改行に正規化する。 */
._diff-line {
  display: block;
  padding-left: calc((var(--line-no-width, 3ch) + 1.5ch) * 2);
  text-indent: calc(-1 * (var(--line-no-width, 3ch) + 1.5ch) * 2);
}

._line-no {
  display: inline-block;
  width: var(--line-no-width, 3ch);
  margin-right: 1.5ch;
  text-align: right;
  color: var(--color-element-hover);
  user-select: none;
  /* contenteditable host の UA スタイル `word-wrap: break-word` (継承プロパティ) が
     この box まで届くため、数字が幅 Nch を僅かでも超えると桁の途中で折り返される。
     コードフォント (`_diff-scroll`) は通常 monospace で桁 advance = ch だが、
     設定 (preview.codeFontFamily) や fallback font が proportional に解決される環境では
     桁 glyph が ch ("0" の幅) を超えうる。nowrap で折り返しを構造的に禁止し、
     tabular-nums で全桁の advance を "0" と同幅に揃えて「N 桁 = Nch」の幅契約を
     フォント非依存で成立させる。 */
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 行番号は DOM テキストとして持たず `data-line-no` の値を `::before` で描画する。
   擬似要素 content は構造的にクリップボード対象外なので、Cmd+A / Cmd+C で行番号が
   コピーに混入しない (CodePreview の規律と同形)。
   button / static span どちらも `._line-no` を共有し、属性は同名 `data-line-no` で
   統一しているので 1 ルールで両方に効く。 */
._line-no::before {
  content: attr(data-line-no);
}

._line-no-btn {
  padding: 0;
  background: transparent;
  border: none;
  /* button の UA 既定 font (OS UI font) の打ち消しは shorthand `font: inherit` ではなく
     longhand で行う。`font` shorthand は reset-only sub-property の `font-variant-numeric`
     を初期値 normal に戻すため、同 specificity 後勝ちで `_line-no` の tabular-nums
     (寸法契約の SSOT) を潰してしまう。 */
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  font-style: inherit;
  line-height: inherit;
  cursor: pointer;
}

._line-no-btn:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

/* keyboard focus 可視化。silent dead button 禁止規約の延長 */
._line-no-btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
  color: var(--color-primary);
}

._line-text {
  white-space: pre;
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
  background-color: var(--color-panel);
  color: var(--color-foreground-low);
  font-size: 0.75rem;
  user-select: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
}

._hunk-bar:hover {
  background-color: var(--color-element);
  color: var(--color-foreground);
}

._hunk-bar-icon {
  flex-shrink: 0;
}

/* split view: section ごとに左右の半身を 1fr / 1fr で並べる外側 grid。
   各半身は CSS subgrid で親の row track を継承し、内側の `_split-row` を 1 block 1 track
   ずつ並べる。`_split-section` には `grid-template-rows: repeat(N, auto)` を style binding
   で N = 行数として渡し、両半身が同じ N 個の row track を共有する。これで word-wrap で
   左右の折返し行数が違っても、行ごとに高い方の高さに track が伸びて左 row j と右 row j が
   同じ親 track に置かれ、左右の行が縦に揃う。
   `_split-row` 1 つに hanging indent (padding-left + 負 text-indent) を当てて、word-wrap 時の
   折返し行も line-no 幅で揃う挙動を保つ。半身内側を 2-col サブグリッドにする旧案は grid 子の
   blockification で contenteditable コピー時に行間に余計な `\n` が混じるため不採用。各 row は
   半身配下のただ 1 つの直接子 (grid item) なので、blockification は 1 行 1 個に収まり clipboard
   は「1 行 = 1 改行」を保つ。
   hunk-bar は section の外、scroll コンテナ直下の sibling に置くため、どの contenteditable
   subtree にも入らず Cmd+A scope から構造的に除外される。
   split は section ごとに左右半身それぞれが独立した contenteditable=true の editing host。
   `user-select: none` は selectAll 経路で仕様保証が無いため scope 制御には使わない。 */
._split-section {
  display: grid;
  /* `minmax(0, 1fr)` でトラックの min を 0 に固定し、コンテンツ幅に依らず左右を等分する。
     `1fr` (= `minmax(auto, 1fr)`) だと auto 側の automatic minimum が nowrap (`white-space: pre`)
     の長い行の min-content を拾い、半身がトラックを押し広げて左右がコンテンツ量比で割れる。
     50% を越える長い行は半身の枠を越えて overflow: visible のまま描画され、diff 全体を囲む
     `_diff-scroll` (overflow-auto) の横スクロールで参照する。半身単位の overflow box は持たない。 */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  /* grid-template-rows は section ごとに style binding で `repeat(N, auto)` を渡す (= 上記コメント参照) */
}

._split-half {
  display: grid;
  grid-template-rows: subgrid;
  /* 親と同じく min を 0 に固定し、半身内の単一カラムを 50% 枠に収める。`1fr` だと inner track が
     長い行の min-content まで伸びて半身の content box が 50% を越えて膨らむ (外側 section の
     50/50 自体は min 0 トラックなので保たれるが、min 0 で両 grid を揃えて挙動を一致させる)。
     長い行は親と同様 overflow: visible で枠を越え `_diff-scroll` の横スクロールに逃げる。 */
  grid-template-columns: minmax(0, 1fr);
  /* `grid-row: 1 / -1` は subgrid 親 row track を継承するための定型。両半身に同じ範囲を当てても
     `_split-section` が 2 列 grid で左右が別 column に置かれるので row は衝突しない。 */
  grid-row: 1 / -1;
}

/* contenteditable host (`_unified-section` / `_split-half`) の focus 表示。
   `outline: none` で全部消すと keyboard 経路の focus 視認が失われるため、
   `:focus-visible` で keyboard focus のときだけ outline を出し、mouse click 経路は
   UA 既定で outline なし (`:focus-visible` 非マッチ)。 */
._unified-section:focus-visible,
._split-half:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

._split-row {
  display: block;
  padding-left: calc(var(--line-no-width, 3ch) + 1.5ch);
  text-indent: calc(-1 * (var(--line-no-width, 3ch) + 1.5ch));
}

/* 旧 `_split-divider` (個別セルの左 border) を半身境界の border-left に統合。
   セル単位で divider を持つよりも構造が SSOT に揃う。
   grid-column は DOM 順で auto-place されるため明示不要 (`_split-section` の
   `grid-template-columns: 1fr 1fr` と 2 つ並ぶ半身で 1 列目 / 2 列目に置かれる)。 */
._split-half-right {
  border-left: 1px solid var(--color-element);
  padding-left: 0.5ch;
}

/* 片側のみの remove / add 行で反対行を灰色で埋める。`_split-filler` は `_split-row` に
   class として乗るので行全体が灰色になる (旧構造は cell 単位だったが、per-row block 化で
   row 単位の塗りに統合)。 */
._split-filler {
  background-color: var(--color-panel);
}

/* hunk-bar / section は scroll コンテナ直下に sibling として置かれる block 要素。
   grid container 内に居ないので grid-column span 等の追加 CSS は不要。 */
</style>
