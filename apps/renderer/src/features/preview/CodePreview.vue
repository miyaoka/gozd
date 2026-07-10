<doc lang="md">
Monaco Editor (readonly) によるコード表示。ハイライトは Shiki の TextMate grammar を
`@shikijs/monaco` 経由で Monaco に接ぎ込む (`monacoSetup.ts`)。

旧実装は Shiki の HTML 出力を contenteditable で表示していたが、Monaco readonly に置き換えた。
狙いは検索 (Cmd+F の find widget) と大きいファイルの仮想スクロール。編集モード (CodeEditor) と
同じエディタ基盤になるため、モード切替での見た目のジャンプも消える。

## blame anchor の契約

行番号クリック → blame popover の起動は `monacoSetup.ts` の `wireGutterLineClick` に委譲する
(クリック判定・popover light dismiss との位相・anchor 配置の設計判断は同 docstring 参照)。
anchor は Monaco 内部の DOM ではなく、コンポーネントが所有する不可視要素をクリック行の
gutter セル位置に重ねて使う。anchor の位置はクリック時に固定されるため、スクロールすると
行とずれる。ずれた位置を指す popover を残さないよう、スクロールで `scrolled` を emit し
親 (PreviewPane) が blame popover を閉じる。

旧実装の行番号 `<button>` が持っていた keyboard 到達性 (Tab + Enter) は Monaco gutter では
提供できず失われる。blame は mouse 専用機能に倒すトレードオフ。

## fallback

Monaco (重量 chunk) のロード完了までは行番号なしのプレーンテキストを表示する。
</doc>

<script setup lang="ts">
import type * as Monaco from "monaco-editor";
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { previewCodeFontFamily, previewFontSize } from "./previewConfig";

const props = withDefaults(
  defineProps<{
    content: string;
    filePath: string;
    /** スクロール・ハイライト対象の行番号（1-based） */
    lineNumber?: number;
    /** 同一パス・同一行番号でもスクロールを再発火させるためのカウンタ */
    revealVersion: number;
    wordWrap: boolean;
    /**
     * 行番号を blame ボタンとして扱うか。false なら gutter click を無視し、
     * hover も cursor:pointer も出さない (silent dead button を避ける契約)。
     */
    blameEnabled?: boolean;
  }>(),
  { blameEnabled: false },
);

const emit = defineEmits<{
  /** 行番号クリック。anchorEl は popover anchor 用、line は 1-based の表示行 */
  lineNumberClick: [payload: { line: number; anchorEl: HTMLElement }];
  /** エディタのスクロール。gutter anchor が仮想化で無効になるため親は blame popover を閉じる */
  scrolled: [];
}>();

const containerRef = ref<HTMLElement>();
/** blame popover の anchor (自前所有の固定要素。monacoSetup の wireGutterLineClick が位置決め) */
const blameAnchorRef = ref<HTMLElement>();
const editorReady = ref(false);
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
let activeDecorations: Monaco.editor.IEditorDecorationsCollection | undefined;

const ACTIVE_LINE_CLASS = "_monaco-active-line";

/** 言語解決 await 中にファイルが切り替わった場合に古い解決結果を捨てるための世代カウンタ */
let langEpoch = 0;

/** 指定行までスクロールしてハイライトする。範囲外の行は無視する (旧実装と同じ挙動) */
function revealLine(line: number) {
  if (editor === undefined) return;
  const lineCount = editor.getModel()?.getLineCount() ?? 0;
  if (line > lineCount) return;
  editor.revealLineInCenter(line);
  activeDecorations?.set([
    {
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: true, className: ACTIVE_LINE_CLASS },
    },
  ]);
}

onMounted(async () => {
  const el = containerRef.value;
  if (el === undefined) return;
  const myEpoch = ++langEpoch;
  const { monaco, MONACO_THEME, resolveMonacoLanguage, wireGutterLineClick } =
    await import("./monacoSetup");
  const language = await resolveMonacoLanguage(props.filePath);
  // await 中に unmount された場合、containerRef は Vue によって undefined に戻される。
  // ファイル切替 (watch 側が最新の言語解決を持つ) は世代不一致で捨てる。
  if (containerRef.value !== el || myEpoch !== langEpoch) return;
  // create より先に fallback → コンテナへ表示を切り替える。v-show=false (display:none) の
  // コンテナに create すると初期サイズ 0 で layout され、直後の revealLineInCenter の
  // センタリング計算が壊れるため。nextTick 直後 (同一 task 内) に create するので
  // 空白フレームは描画されない。
  editorReady.value = true;
  await nextTick();
  if (containerRef.value !== el) return;
  editor = monaco.editor.create(el, {
    value: props.content,
    language,
    theme: MONACO_THEME,
    readOnly: true,
    // DOM レベルでも readonly (contenteditable ではなく aria-readonly な textbox) にし、
    // IME 起動等の編集系イベントを構造的に抑止する
    domReadOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: previewCodeFontFamily.value || undefined,
    fontSize: previewFontSize.value > 0 ? previewFontSize.value : undefined,
    wordWrap: props.wordWrap ? "on" : "off",
    scrollBeyondLastLine: false,
    // readonly ビューアにカーソル行の常時ハイライトは不要 (reveal 行の decoration と紛れる)
    renderLineHighlight: "none",
    ariaLabel: "File contents",
  });
  activeDecorations = editor.createDecorationsCollection();
  // gutter クリック → blame 起動。判定と anchor 配置の設計判断は wireGutterLineClick の
  // docstring (monacoSetup.ts) を参照。
  wireGutterLineClick(
    editor,
    () => blameAnchorRef.value,
    () => props.blameEnabled,
    (payload) => emit("lineNumberClick", payload),
  );
  editor.onDidScrollChange(() => emit("scrolled"));
  if (props.lineNumber !== undefined) revealLine(props.lineNumber);
});

onUnmounted(() => {
  langEpoch++;
  editor?.dispose();
  editor = undefined;
});

/**
 * ファイル切替 / 内容更新 (fsChange 再取得) の反映。コンポーネントはファイルを跨いで
 * 再利用されるため、model の中身と言語をここで差し替える。旧実装 (DOM 全置換) と挙動を
 * 揃え、スクロールは先頭へ戻す (lineNumber 指定があれば reveal が優先)。
 */
watch(
  () => [props.content, props.filePath] as const,
  async ([, filePath], [, oldFilePath]) => {
    if (editor === undefined) return; // 初期 mount 前。onMounted が最新 props で作る
    activeDecorations?.clear();
    if (filePath !== oldFilePath) {
      const myEpoch = ++langEpoch;
      // monacoSetup は初回 mount で評価済みのため、この import は同期的に解決する
      const { monaco, resolveMonacoLanguage } = await import("./monacoSetup");
      const language = await resolveMonacoLanguage(filePath);
      if (editor === undefined || myEpoch !== langEpoch) return;
      const model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, language);
    }
    if (editor.getValue() !== props.content) editor.setValue(props.content);
    if (props.lineNumber !== undefined) {
      revealLine(props.lineNumber);
    } else {
      editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    }
  },
);

/** selectPath のたびにスクロールを再発火（同一パス・同一行番号でも対応） */
watch(
  () => props.revealVersion,
  () => {
    if (props.lineNumber !== undefined) {
      revealLine(props.lineNumber);
    } else {
      activeDecorations?.clear();
    }
  },
);

watch(
  () => props.wordWrap,
  (wrap) => {
    editor?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  },
);
</script>

<template>
  <div class="relative size-full">
    <!-- Monaco コンテナ。ロード完了までは v-show で隠し、fallback のプレーンテキストを出す。
         v-if にしないのは、mount 時の dynamic import await 中もコンテナ DOM を保持して
         create 先を確保するため。 -->
    <div
      v-show="editorReady"
      ref="containerRef"
      class="size-full"
      :class="blameEnabled ? '_blame-gutter' : ''"
    />

    <!-- blame popover の anchor。Monaco 内部の DOM は anchor に使えない
         (wireGutterLineClick の docstring 参照) ため、自前の不可視要素をクリック行の
         gutter セル位置に重ねて popover の source にする -->
    <div ref="blameAnchorRef" class="pointer-events-none absolute" aria-hidden="true" />

    <!-- フォールバック: プレーンテキスト（Monaco chunk ロード完了まで） -->
    <pre
      v-if="!editorReady"
      class="p-4 text-sm/tight whitespace-pre text-foreground"
      role="region"
      aria-label="File contents"
    ><code>{{ content }}</code></pre>
  </div>
</template>

<style scoped>
/* reveal 対象行のハイライト（Monaco decoration の className 経由で view overlay に付与される） */
:deep(._monaco-active-line) {
  background-color: color-mix(in oklch, var(--color-warning) 15%, transparent);
}

/* blame ON のときだけ gutter の行番号をクリック可能に見せる。
   blame OFF では Monaco 標準のまま (cursor も hover も出さない = silent dead button 禁止)。 */
._blame-gutter :deep(.margin-view-overlays .line-numbers) {
  cursor: pointer;
}

._blame-gutter :deep(.margin-view-overlays .line-numbers:hover) {
  color: var(--color-primary);
  text-decoration: underline;
}
</style>
