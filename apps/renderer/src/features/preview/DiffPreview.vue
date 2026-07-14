<doc lang="md">
hunk 単位の diff ビュー。unified / split の 2 モードを切り替える。

## 設計

diff 計算は SSOT を git に置き、renderer は `rpcGitDiffHunks` で取得した `hunks` と
`oldTotalLines` / `newTotalLines` を描画するだけ。全文 jsdiff を JS で回すと
大ファイル (`pnpm-lock.yaml` 等) で Myers LCS が O(N×M) で固まるため、
git の C 実装 (xdiff) に処理を委ねる。

## 描画

watch で取得した hunks を unified / split 両方の base items に一度に展開し、
state.success に保持する。view mode の切り替えで再 fetch は走らない。

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

## 行内 (文字単位) ハイライト

行単位 diff の SSOT は git のまま、変更ブロック (removed run × added run) の内側だけを
`intraLineDiff.ts` (monaco-editor deep import の VSCode `DefaultLinesDiffComputer`) で
文字単位に再計算する。表示専用の追加レイヤーなので git の hunk 構造とは矛盾しない。

トーン設計は VSCode の line/char decoration 二層と同型。行背景は従来の diff 色
(subtle、step 3)、行内変更範囲は 1 段明るい subtle-emphasis (step 5) を重ねる。
変更フラグメントが浮き、同一部分が行背景のトーンに沈んで見える。
沈む側 (step 2 以下) でトーン差を作る案は、dark パレットの低 step 圧縮 (ΔL 0.03) で
人間に判別できず不採用。コントラストは明るい側でしか成立しない。

純粋な追加 / 削除行は VSCode では行全体が char 強度になるが、gozd は従来の subtle を
維持する (大きな追加ブロックが明るい壁になるのを避ける。GitHub と同じ判断)。
degrade した run (予算切れ / timeout) も従来の行単位表示のまま。

計算はメインスレッド同期実行のため、1 ファイル全 run 合算の予算
(`INTRA_LINE_DIFF_BUDGET_MS`) で打ち切る。予算切れ / run 単体の timeout は
行単位表示への degrade (VSCode と同じ戦略) で、エラーにはしない。

描画は DiffLineContent が「トークン境界 × 変更範囲境界」の両方で segment を切って合成する。
強調は inline span の background なので、contenteditable コピーの clipboard 正規化
(1 行 = 1 改行) には影響しない。

## 入力契約

`original` / `current` は UTF-8 として解釈可能なテキストである必要がある。バイナリは
content の型 narrow（`currentText` / `originalText` がバイナリ (bytes) で `undefined` に
倒れる）により diff leaf の描画条件を満たさず、本コンポーネントに渡らない前提。
万一すり抜けた場合は main 側で `Binary files ... differ` を検知して error にトーストする。

> [!NOTE]
> 複数行コメントやテンプレートリテラルの開始/終了が変更に含まれる場合、
> unchanged 行でも original と current でトークン結果が異なりうる。
> unified では unchanged を常に current のトークンで描画するため、
> 旧側の文脈との不整合が生じる場合がある。split では左右で別トークンを使うため整合する。

## 編集パス (`editable` prop)

編集可能ファイル (worktree 実ファイルの uncommitted diff) は VS Code の diff editor と同じく
**常時編集状態** で表示する。上記の自前 hunk 描画 (contenteditable + Shiki トークン) とは
完全に別の描画パスで、Monaco の `createDiffEditor` を丸ごとマウントし original (readonly) /
modified (編集可) を比較する。自前 hunk 描画は commit / PR diff / summary 等の読み取り専用
文脈で使われ続ける。

- 編集内容の SSOT は `usePreviewEditStore.draftContent`。親 (PreviewPane) は `current` prop に
  draft を渡し、modified 側の変更を `update:current` で受けて `updateDraft` に流す。
  discard / 外部変更 / save 後の再取得はすべて props → model の同期 watch 1 経路で反映される
  (等値チェックで自分の編集の round-trip を無視する。CodePreview と同じ設計)
- diff 計算は Monaco 自身の内蔵アルゴリズムに委ねる (read-only 表示は git 由来の SSOT を保つ
  設計のままだが、編集パスだけは Monaco の diff 計算に委譲するトレードオフを取る)。
  `hideUnchangedRegions` で unchanged 領域の折り畳みも Monaco 標準機能に任せる
- Split / Unified トグルは Monaco の `renderSideBySide` (side-by-side / inline) にマップし、
  編集中も両方の view を使える

`monaco-editor` は全言語入りの重量パッケージのため、`editable` が true になったタイミングで
`import("./monacoSetup")` して遅延ロードする。read-only 表示のみの利用者
(ChangesSummaryView 等) はロードしない。例外は行内ハイライト用の diff computer サブツリー
(intraLineDiff.ts の deep import) で、これは monaco 本体 (エディタ UI / worker / 言語サービス)
を含まない純計算部のみを read-only 側の eager バンドルに載せる。
</doc>

<script setup lang="ts">
import type { DiffExpandedLine, DiffHunk } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import type * as Monaco from "monaco-editor";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { abortComposition, blockEdit } from "./contenteditableHostGuard";
import DiffLineContent from "./DiffLineContent.vue";
import { type ColRange, computeIntraLineRanges } from "./intraLineDiff";
import type { GutterBlameHandle } from "./monacoSetup";
import { previewCodeFontFamily, previewFontSize } from "./previewConfig";
import { rpcGitDiffExpandLines, rpcGitDiffHunks } from "./rpc";
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
     * true のとき Monaco diff editor で描画し、modified (current 側) を編集可能にする。
     * original は常に read-only。詳細は doc の「編集パス」を参照。
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
  /** editable 時、Monaco modified model の内容が変わるたびに発火。親が editStore.updateDraft に流す */
  "update:current": [value: string];
  /** editable 時のエディタスクロール。blame anchor が固定位置のため親は popover を閉じる */
  scrolled: [];
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
  /** 行内 (文字単位) 変更範囲。key は old / new 側それぞれの 1-based 絶対行番号 */
  oldInnerRanges: Map<number, ColRange[]>;
  newInnerRanges: Map<number, ColRange[]>;
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
 * hunk 内の 1 セグメント。context 1 行、または「連続する removed run + added run」の
 * 1 変更ブロック。unified / split の展開と行内 diff の run 対象抽出が同じ走査を必要と
 * するため、hunk lines の走査 (絶対行番号の採番 + run のグルーピング) をここに一本化する。
 */
type HunkSegment =
  | { kind: "context"; oldLineNo: number; newLineNo: number; text: string }
  | {
      kind: "run";
      removeds: { lineNo: number; text: string }[];
      addeds: { lineNo: number; text: string }[];
    };

function collectHunkSegments(h: DiffHunk): HunkSegment[] {
  const segments: HunkSegment[] = [];
  let oldLine = h.oldStart;
  let newLine = h.newStart;
  let i = 0;
  while (i < h.lines.length) {
    const line = h.lines[i];
    if (line.kind === "context") {
      segments.push({ kind: "context", oldLineNo: oldLine, newLineNo: newLine, text: line.text });
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
    segments.push({ kind: "run", removeds, addeds });
  }
  return segments;
}

/**
 * 1 hunk のセグメント列を unified 行アイテムに展開する。
 * run は removed → added の順に並べる (git の unified diff 出力と同じ並び)。
 */
function expandHunkLinesUnified(segments: HunkSegment[], items: DiffViewItem[]): void {
  for (const seg of segments) {
    if (seg.kind === "context") {
      items.push({
        type: "line",
        kind: "unchanged",
        text: seg.text,
        oldLineNo: seg.oldLineNo,
        newLineNo: seg.newLineNo,
      });
      continue;
    }
    for (const r of seg.removeds) {
      items.push({ type: "line", kind: "removed", text: r.text, oldLineNo: r.lineNo });
    }
    for (const a of seg.addeds) {
      items.push({ type: "line", kind: "added", text: a.text, newLineNo: a.lineNo });
    }
  }
}

/**
 * 1 hunk のセグメント列を split 行アイテムに展開する。
 * unchanged は両側にテキストを持つ context row、run は removed run と added run を
 * 貪欲にペアリングして同じ row に左右配置する。run 長が不揃いの場合は
 * 余った片側だけの row が並ぶ。
 */
function expandHunkLinesSplit(segments: HunkSegment[], items: DiffSplitViewItem[]): void {
  for (const seg of segments) {
    if (seg.kind === "context") {
      items.push({
        type: "split-row",
        kind: "context",
        oldLineNo: seg.oldLineNo,
        oldText: seg.text,
        newLineNo: seg.newLineNo,
        newText: seg.text,
      });
      continue;
    }
    const pairCount = Math.max(seg.removeds.length, seg.addeds.length);
    for (let j = 0; j < pairCount; j++) {
      const r = seg.removeds[j];
      const a = seg.addeds[j];
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
 * 1 ファイル分の行内 diff 計算に許す合計時間。VSCode の diff は worker で走るが gozd の
 * 行内 diff はメインスレッド同期実行のため、巨大 diff (lock ファイル等) で UI が固まらない
 * よう全 run 合算の予算で打ち切る。予算切れ以降の run は行単位表示に degrade する。
 */
const INTRA_LINE_DIFF_BUDGET_MS = 500;

/**
 * 変更ブロック (removed run × added run 両方が非空のもの) の行内変更範囲を収集し、
 * 絶対行番号 key のマップに積む。予算切れは想定内の degrade だが、観察できるよう
 * 初回だけ stderr にログを残す (budget.exhausted フラグで 1 回に抑制)。
 */
function collectIntraLineRanges(
  segments: HunkSegment[],
  oldRanges: Map<number, ColRange[]>,
  newRanges: Map<number, ColRange[]>,
  budget: { deadline: number; exhausted: boolean },
): void {
  for (const seg of segments) {
    if (seg.kind !== "run") continue;
    if (seg.removeds.length === 0 || seg.addeds.length === 0) continue;
    const remaining = budget.deadline - performance.now();
    if (remaining <= 0) {
      if (!budget.exhausted) {
        budget.exhausted = true;
        console.error(
          `[DiffPreview] intra-line diff budget (${INTRA_LINE_DIFF_BUDGET_MS}ms) exhausted; ` +
            "remaining runs degrade to line-level highlight",
        );
      }
      return;
    }
    const result = computeIntraLineRanges(
      seg.removeds.map((r) => r.text),
      seg.addeds.map((a) => a.text),
      remaining,
    );
    // undefined = hitTimeout。この run だけ行内ハイライトなし (従来の行単位表示) に degrade する
    if (result === undefined) continue;
    for (const [idx, list] of result.old) oldRanges.set(seg.removeds[idx].lineNo, list);
    for (const [idx, list] of result.new) newRanges.set(seg.addeds[idx].lineNo, list);
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
): {
  items: DiffViewItem[];
  splitItems: DiffSplitViewItem[];
  oldInnerRanges: Map<number, ColRange[]>;
  newInnerRanges: Map<number, ColRange[]>;
} {
  const items: DiffViewItem[] = [];
  const splitItems: DiffSplitViewItem[] = [];
  const oldInnerRanges = new Map<number, ColRange[]>();
  const newInnerRanges = new Map<number, ColRange[]>();
  const intraLineBudget = {
    deadline: performance.now() + INTRA_LINE_DIFF_BUDGET_MS,
    exhausted: false,
  };
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

    const segments = collectHunkSegments(h);
    expandHunkLinesUnified(segments, items);
    expandHunkLinesSplit(segments, splitItems);
    collectIntraLineRanges(segments, oldInnerRanges, newInnerRanges, intraLineBudget);

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

  return { items, splitItems, oldInnerRanges, newInnerRanges };
}

watch(
  () => [props.original, props.current, props.editable] as const,
  async ([original, current, editable], _, onCleanup) => {
    // 編集パスは Monaco diff editor が描画するため hunk 計算は不要。editable 中は draft の
    // 打鍵ごとに props.current が変わるので、ここで発射すると keystroke ごとに RPC が走る
    if (editable) return;
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
      oldInnerRanges: buildResult.value.oldInnerRanges,
      newInnerRanges: buildResult.value.newInnerRanges,
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

/**
 * diff 背景のトーン設計 (VSCode の line/char decoration 二層と同型):
 * - 行背景 = 従来の diff 色 (subtle、step 3)。VSCode の弱い line 背景に相当
 * - 行内変更範囲 = 1 段明るい subtle-emphasis (step 5) を重ねる。VSCode の char decoration
 *   に相当し、変更フラグメントが明るく浮き、同一部分は行背景のトーンに沈んで見える
 *
 * dark パレットの低 step (1-3) は差が圧縮されていて (ΔL 0.03-0.04)、subtle より暗い側で
 * トーン差を作っても人間には判別できない。コントラストは明るい側 (step 3 → 5、ΔL 0.08)
 * でしか成立しない。
 *
 * VSCode は純粋な追加 / 削除行も行全体を char 強度にするが、gozd では従来の subtle を
 * 維持する (大きな追加ブロックが明るい壁になるのを避ける。GitHub と同じ判断)。
 */
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

/** 行内 (文字単位) 変更範囲の強調背景。VSCode の char decoration に相当 */
const INNER_MARK_CLASSES: Record<DiffLineKindName, string> = {
  added: "bg-success-subtle-emphasis",
  removed: "bg-destructive-subtle-emphasis",
  unchanged: "",
};

const originalTokens = ref<ThemedToken[][]>();
const currentTokens = ref<ThemedToken[][]>();

watch(
  () => [props.original, props.current, props.filePath, props.editable] as const,
  async (_, __, onCleanup) => {
    originalTokens.value = undefined;
    currentTokens.value = undefined;
    // 編集パスは Monaco が描画するため tokens は不要。hunk 計算 watch と同じ理由で、
    // editable 中は draft の打鍵ごとに props.current が変わり、ガードしないと毎打鍵
    // 全文トークン化が走る (結果は read-only 描画専用で誰も表示しない)
    if (props.editable) return;

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

/** unified の renderRows: 展開済みバーを unchanged 行に置換した後、tokens と行内 range を埋め込む */
const renderRows = computed(() => {
  const s = state.value;
  if (s.kind !== "success") return [];
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  const expandedMap = expansions.value;

  const rendered: (RenderedUnifiedLine | DiffBarItem)[] = [];
  for (const item of s.baseItems) {
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
            s,
          ),
        );
      }
      continue;
    }
    rendered.push(buildRenderedLine(item, orig, curr, s));
  }
  return rendered;
});

function buildRenderedLine(
  item: DiffLineItem,
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
  s: DiffSuccessState,
): RenderedUnifiedLine {
  let tokens: ThemedToken[] | undefined;
  if (orig && curr) {
    if (item.kind === "removed" && item.oldLineNo !== undefined) {
      tokens = orig[item.oldLineNo - 1];
    } else if (item.newLineNo !== undefined) {
      tokens = curr[item.newLineNo - 1];
    }
  }
  let innerRanges: ColRange[] | undefined;
  if (item.kind === "removed" && item.oldLineNo !== undefined) {
    innerRanges = s.oldInnerRanges.get(item.oldLineNo);
  } else if (item.kind === "added" && item.newLineNo !== undefined) {
    innerRanges = s.newInnerRanges.get(item.newLineNo);
  }
  return { ...item, tokens, innerRanges };
}

/** split の renderRows: 展開済みバーを context row に置換した後、両側のトークンと行内 range を埋め込む */
const splitRenderRows = computed(() => {
  const s = state.value;
  if (s.kind !== "success") return [];
  const orig = originalTokens.value;
  const curr = currentTokens.value;
  const expandedMap = expansions.value;

  const rendered: (RenderedSplitLine | DiffBarItem)[] = [];
  for (const item of s.baseSplitItems) {
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
            s,
          ),
        );
      }
      continue;
    }
    rendered.push(buildRenderedSplitRow(item, orig, curr, s));
  }
  return rendered;
});

function buildRenderedSplitRow(
  row: DiffSplitRowItem,
  orig: ThemedToken[][] | undefined,
  curr: ThemedToken[][] | undefined,
  s: DiffSuccessState,
): RenderedSplitLine {
  const oldTokens = orig && row.oldLineNo !== undefined ? orig[row.oldLineNo - 1] : undefined;
  const newTokens = curr && row.newLineNo !== undefined ? curr[row.newLineNo - 1] : undefined;
  // 行内 range は modified 行にしか積まれないが、lookup は行番号だけで安全
  // (context 行の行番号は collectIntraLineRanges の対象外なので必ず miss する)
  const oldInnerRanges =
    row.kind === "modified" && row.oldLineNo !== undefined
      ? s.oldInnerRanges.get(row.oldLineNo)
      : undefined;
  const newInnerRanges =
    row.kind === "modified" && row.newLineNo !== undefined
      ? s.newInnerRanges.get(row.newLineNo)
      : undefined;
  return { ...row, oldTokens, newTokens, oldInnerRanges, newInnerRanges };
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
type RenderedUnifiedLine = DiffLineItem & { tokens?: ThemedToken[]; innerRanges?: ColRange[] };
type RenderedSplitLine = DiffSplitRowItem & {
  oldTokens?: ThemedToken[];
  newTokens?: ThemedToken[];
  oldInnerRanges?: ColRange[];
  newInnerRanges?: ColRange[];
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
 * 編集パス。Monaco の `createDiffEditor` を丸ごとマウントし、read-only 表示 (自前 hunk 描画) とは
 * 完全に別の描画パスにする。original は readonly、modified (= current 側) のみ編集可能。
 * 設計判断は doc の「編集パス」を参照。
 */
const monacoContainerRef = ref<HTMLElement>();
/** blame popover の anchor (自前所有の固定要素。monacoSetup の wireGutterBlame が位置決め) */
const blameAnchorRef = ref<HTMLElement>();
let monacoDiffEditor: Monaco.editor.IStandaloneDiffEditor | undefined;
/** 左右半身それぞれの blame トリガーの有効状態を props.blameEnabled と同期するためのハンドル */
let blameHandles: GutterBlameHandle[] = [];

/**
 * `monaco-editor` は全言語入りの重量パッケージ (`monacoSetup.ts` 参照) のため、編集パスの
 * mount 時まで `import("./monacoSetup")` で遅延ロードする。
 */
let mountGeneration = 0;
async function mountMonacoDiffEditor() {
  const el = monacoContainerRef.value;
  // unmount 済みの template ref は Vue により null に戻る (undefined は初期値のみ)。
  if (!el) return;
  const myGeneration = ++mountGeneration;
  const setupResult = await tryCatch(
    (async () => {
      const { monaco, MONACO_THEME, resolveMonacoLanguage, wireGutterBlame } =
        await import("./monacoSetup");
      const language = await resolveMonacoLanguage(props.filePath);
      return { monaco, MONACO_THEME, language, wireGutterBlame };
    })(),
  );
  if (!setupResult.ok) {
    // Monaco chunk / grammar の dynamic import 失敗経路。silent にエディタ無しへ沈黙すると
    // 原因を追えないため通知する (renderer 規約: silent drop 禁止)
    notification.error("Failed to load editor", setupResult.error);
    return;
  }
  const { monaco, MONACO_THEME, language, wireGutterBlame } = setupResult.value;
  // await 中に editable の再トグル / unmount が起きた場合は何もしない (世代不一致で判定)。
  if (myGeneration !== mountGeneration || monacoContainerRef.value !== el || !props.editable) {
    return;
  }
  const originalModel = monaco.editor.createModel(props.original, language);
  const modifiedModel = monaco.editor.createModel(props.current, language);
  monacoDiffEditor = monaco.editor.createDiffEditor(el, {
    originalEditable: false,
    readOnly: false,
    renderSideBySide: viewMode.value === "split",
    automaticLayout: true,
    theme: MONACO_THEME,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    hideUnchangedRegions: { enabled: true },
    wordWrap: props.wordWrap ? "on" : "off",
    fontFamily: previewCodeFontFamily.value || undefined,
    fontSize: previewFontSize.value > 0 ? previewFontSize.value : undefined,
    // preview は overflow を隠す popover 内にあるため、hover / suggest 等の overflow widget を
    // position:fixed で描画してエディタ境界を越えられるようにする (境界で clip されるのを防ぐ)
    fixedOverflowWidgets: true,
  });
  monacoDiffEditor.setModel({ original: originalModel, modified: modifiedModel });
  const modifiedEditor = monacoDiffEditor.getModifiedEditor();
  // 編集内容の SSOT は editStore.draftContent。ここでは Monaco の変更を親 (PreviewPane) に
  // 伝播するだけで、dirty 判定は持たない。round-trip (同値で戻る props.current) は
  // 下の props 同期 watch の等値チェックで止まる。
  modifiedEditor.onDidChangeModelContent(() => {
    emit("update:current", modifiedEditor.getValue());
  });
  // gutter クリック / context menu action → blame 起動 (side 別)。old 側 = 比較元 rev、
  // new 側 = working tree。read-only の自前 hunk 描画と同じ side 契約で親へ通知する。
  // 判定と anchor 配置の設計判断は wireGutterBlame の docstring (monacoSetup.ts) を参照。
  blameHandles = (
    [
      ["old", monacoDiffEditor.getOriginalEditor()],
      ["new", modifiedEditor],
    ] as const
  ).map(([side, sideEditor]) => {
    const handle = wireGutterBlame(
      sideEditor,
      () => blameAnchorRef.value,
      ({ line, anchorEl }) => emit("lineNumberClick", { side, line, anchorEl }),
    );
    handle.setEnabled(props.blameEnabled);
    return handle;
  });
  // blame anchor はクリック時の位置に固定した自前要素のため、スクロールで親が popover を閉じる
  // (CodePreview の scrolled と同じ契約)。左右はスクロール同期するので modified 側のみ監視する。
  modifiedEditor.onDidScrollChange(() => emit("scrolled"));
}

function unmountMonacoDiffEditor() {
  mountGeneration++; // in-flight な mountMonacoDiffEditor (dynamic import 待ち) を無効化する
  const model = monacoDiffEditor?.getModel();
  model?.original.dispose();
  model?.modified.dispose();
  monacoDiffEditor?.dispose();
  monacoDiffEditor = undefined;
  blameHandles = []; // トリガー本体は editor.dispose() で解放される (wireGutterBlame の契約)
}

watch(
  () => props.editable,
  (editable) => {
    if (!editable) {
      unmountMonacoDiffEditor();
      return;
    }
    void nextTick(mountMonacoDiffEditor);
  },
  { immediate: true },
);

/**
 * props → Monaco model の同期。discard (draft が saved に戻る) / クリーン時の外部変更追従 /
 * save 後の再取得を、すべてこの 1 経路で model に反映する。自分の編集の round-trip
 * (modified 変更 → update:current → 同値の props.current) は等値チェックで無視され、
 * 打鍵のたびに setValue でカーソルが飛ぶことを防ぐ (CodePreview の content watch と同じ設計)。
 */
watch(
  () => [props.original, props.current] as const,
  ([original, current]) => {
    const model = monacoDiffEditor?.getModel();
    if (!model) return;
    if (model.original.getValue() !== original) model.original.setValue(original);
    if (model.modified.getValue() !== current) model.modified.setValue(current);
  },
);

/**
 * ファイル切替 (diff タブのまま別ファイルを選択) への言語追従。編集パスは unmount されずに
 * props だけ入れ替わるため、model の言語をここで差し替える。
 */
watch(
  () => props.filePath,
  async (filePath) => {
    if (monacoDiffEditor === undefined) {
      // editable なのにエディタが無い = 前回 mount が失敗している (mount 進行中なら世代管理が
      // 最新 props で作り直す)。ファイル切替を機に再試行し、silent な空表示の継続を避ける
      // (CodePreview の content watch と同じ回復契約)
      if (props.editable) void nextTick(mountMonacoDiffEditor);
      return;
    }
    const myGeneration = mountGeneration;
    const result = await tryCatch(
      (async () => {
        const { monaco, resolveMonacoLanguage } = await import("./monacoSetup");
        const language = await resolveMonacoLanguage(filePath);
        return { monaco, language };
      })(),
    );
    if (!result.ok) {
      // grammar の on-demand load 失敗経路。表示は前言語のままで続行できるが silent にしない
      notification.error("Failed to load editor", result.error);
      return;
    }
    if (myGeneration !== mountGeneration || monacoDiffEditor === undefined) return;
    // mountGeneration はファイル切替では増えないため、B → C の連続切替で解決が逆順に完了すると
    // B の言語が最後に適用される。最新の要求 (props.filePath) と一致するときだけ適用する
    if (props.filePath !== filePath) return;
    const model = monacoDiffEditor.getModel();
    if (!model) return;
    result.value.monaco.editor.setModelLanguage(model.original, result.value.language);
    result.value.monaco.editor.setModelLanguage(model.modified, result.value.language);
  },
);

/** Split / Unified トグルを Monaco の side-by-side / inline 表示にマップする */
watch(viewMode, (mode) => {
  monacoDiffEditor?.updateOptions({ renderSideBySide: mode === "split" });
});

watch(
  () => props.wordWrap,
  (wrap) => {
    monacoDiffEditor?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  },
);

/** フォント設定のライブ追従 (CodePreview と同じ契約)。未設定は undefined でデフォルトへ戻す */
watch([previewFontSize, previewCodeFontFamily], ([size, family]) => {
  monacoDiffEditor?.updateOptions({
    fontSize: size > 0 ? size : undefined,
    fontFamily: family || undefined,
  });
});

watch(
  () => props.blameEnabled,
  (enabled) => {
    for (const handle of blameHandles) handle.setEnabled(enabled);
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
</script>

<template>
  <div class="relative flex h-full flex-col">
    <!-- ビューモードトグル (externalViewMode 指定時は親側で 1 本に統合)。
         editable (Monaco diff) では renderSideBySide のマッピング先として機能する -->
    <div
      v-if="(editable || state.kind === 'success') && externalViewMode === undefined"
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

    <!-- blame popover の anchor (編集パス用)。Monaco 内部の DOM は anchor に使えない
         (wireGutterBlame の docstring 参照) ため、自前の不可視要素を対象行の
         gutter セル位置に重ねて popover の source にする -->
    <div ref="blameAnchorRef" class="pointer-events-none absolute" aria-hidden="true" />

    <!-- 編集パス: Monaco の createDiffEditor をマウントするだけのコンテナ
         (script 側の mountMonacoDiffEditor 参照) -->
    <div
      v-if="editable"
      ref="monacoContainerRef"
      class="min-h-0 flex-1"
      :class="blameEnabled ? '_blame-gutter' : ''"
    />

    <!--
      read-only の diff 本体 scroll コンテナ。contenteditable は **section (= hunk-bar で挟まれた可視チャンク) 単位**
      の host で、scroll コンテナ自体は host にしない。hunk-bar は section の **外** に sibling として
      置くため、Cmd+A は focus が居る section だけに閉じ、hunk-bar / 他 section は scope に入らない。
    -->
    <div
      v-else
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
            @compositionstart="abortComposition"
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
                <DiffLineContent
                  :text="row.text"
                  :tokens="row.tokens"
                  :ranges="row.innerRanges"
                  :mark-class="INNER_MARK_CLASSES[row.kind]"
                />
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
              @compositionstart="abortComposition"
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
                  <DiffLineContent
                    v-if="row.oldText !== undefined"
                    :text="row.oldText"
                    :tokens="row.oldTokens"
                    :ranges="row.oldInnerRanges"
                    :mark-class="INNER_MARK_CLASSES.removed"
                  />
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
              @compositionstart="abortComposition"
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
                  <DiffLineContent
                    v-if="row.newText !== undefined"
                    :text="row.newText"
                    :tokens="row.newTokens"
                    :ranges="row.newInnerRanges"
                    :mark-class="INNER_MARK_CLASSES.added"
                  />
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

/* blame ON のときだけ Monaco (編集パス) の gutter 行番号をクリック可能に見せる
   (CodePreview と同じ契約) */
._blame-gutter :deep(.margin-view-overlays .line-numbers) {
  cursor: pointer;
}

._blame-gutter :deep(.margin-view-overlays .line-numbers:hover) {
  color: var(--color-primary);
  text-decoration: underline;
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
