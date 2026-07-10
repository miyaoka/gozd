<doc lang="md">
Monaco Editor によるコード表示・編集。ハイライトは Shiki の TextMate grammar を
`@shikijs/monaco` 経由で Monaco に接ぎ込む (`monacoSetup.ts`)。

`editable` prop で読み取り専用 (Original タブ / commit・PR diff モード / 絶対パス) と
編集可能 (Current タブの worktree 実ファイル。明示的な edit mode は無く常時編集) を切り替える。
単一コンポーネント + `updateOptions` の切替なので、タブ切替でエディタが remount されず
スクロール位置や undo 履歴が保たれる。

- 編集内容の SSOT は `usePreviewEditStore.draftContent`。編集のたびに `update:content` を
  emit し、親 (PreviewPane) が `updateDraft` に流す。content prop との round-trip
  (同値で戻ってくる) は watch 側で無視し、スクロールリセットや decoration クリアを起こさない
- 保存は Cmd+S コマンド / Save ボタン (`usePreviewEdit`)。エディタ自身は保存を持たない
- mount 時に focus を奪わない。preview はファイラー操作の途中で開くため、自動 focus すると
  ファイラーのキーボードナビゲーションを壊す

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
import { tryCatch } from "@gozd/shared";
import type * as Monaco from "monaco-editor";
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
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
    /** 編集可能にするか。true なら編集のたびに update:content を emit する */
    editable?: boolean;
  }>(),
  { blameEnabled: false, editable: false },
);

const emit = defineEmits<{
  /** 行番号クリック。anchorEl は popover anchor 用、line は 1-based の表示行 */
  lineNumberClick: [payload: { line: number; anchorEl: HTMLElement }];
  /** エディタのスクロール。gutter anchor が仮想化で無効になるため親は blame popover を閉じる */
  scrolled: [];
  /** editable 時の編集内容 (エディタ全文)。親が editStore.updateDraft に流す */
  "update:content": [value: string];
}>();

const notification = useNotificationStore();

const containerRef = ref<HTMLElement>();
/** blame popover の anchor (自前所有の固定要素。monacoSetup の wireGutterLineClick が位置決め) */
const blameAnchorRef = ref<HTMLElement>();
const editorReady = ref(false);
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
let activeDecorations: Monaco.editor.IEditorDecorationsCollection | undefined;

const ACTIVE_LINE_CLASS = "_monaco-active-line";

/** 言語解決 await 中にファイルが切り替わった場合に古い解決結果を捨てるための世代カウンタ */
let langEpoch = 0;
/** 直近の setupEditor が失敗したか。単一コンポーネントでファイル跨ぎに remount されないため、
 *  これを見て content watch がファイル切替を機に再試行する (放置すると以降ずっと silent な
 *  プレーンテキスト fallback になる) */
let setupFailed = false;

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

/**
 * setupEditor の実行 + 失敗の観察可能化。Monaco chunk / grammar の dynamic import や create の
 * 失敗経路で、silent に fallback のプレーンテキストへ沈黙すると原因を追えないため通知する
 * (renderer 規約: silent drop 禁止。DiffPreview read-only 経路の "Syntax highlight failed" と
 * 同じ契約)。失敗は setupFailed に記録し、content watch がファイル切替を機に再試行する。
 */
async function trySetupEditor(el: HTMLElement): Promise<void> {
  const myEpoch = ++langEpoch;
  setupFailed = false;
  const result = await tryCatch(setupEditor(el, myEpoch));
  if (!result.ok) {
    setupFailed = true;
    editorReady.value = false;
    notification.error("Failed to load editor", result.error);
  }
}

onMounted(async () => {
  const el = containerRef.value;
  if (el === undefined) return;
  await trySetupEditor(el);
});

async function setupEditor(el: HTMLElement, myEpoch: number): Promise<void> {
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
    readOnly: !props.editable,
    // DOM レベルでも readonly (contenteditable ではなく aria-readonly な textbox) にし、
    // IME 起動等の編集系イベントを構造的に抑止する
    domReadOnly: !props.editable,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: previewCodeFontFamily.value || undefined,
    fontSize: previewFontSize.value > 0 ? previewFontSize.value : undefined,
    wordWrap: props.wordWrap ? "on" : "off",
    scrollBeyondLastLine: false,
    // readonly ビューアにカーソル行の常時ハイライトは不要 (reveal 行の decoration と紛れる)
    renderLineHighlight: props.editable ? "line" : "none",
    ariaLabel: props.editable ? "Edit file contents" : "File contents",
    // preview は overflow を隠す popover 内にあるため、hover / suggest 等の overflow widget を
    // position:fixed で描画してエディタ境界を越えられるようにする (境界で clip されるのを防ぐ)
    fixedOverflowWidgets: true,
  });
  activeDecorations = editor.createDecorationsCollection();
  editor.onDidChangeModelContent(() => {
    if (!props.editable || editor === undefined) return;
    emit("update:content", editor.getValue());
  });
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
}

onUnmounted(() => {
  langEpoch++;
  editor?.dispose();
  editor = undefined;
});

/**
 * ファイル切替 / 内容更新 (fsChange 再取得・discard) の反映。コンポーネントはファイルを
 * 跨いで再利用されるため、model の中身と言語をここで差し替える。内容の入れ替え時は
 * スクロールを先頭へ戻す (lineNumber 指定があれば reveal が優先)。
 *
 * editable 時の編集 round-trip (update:content → updateDraft → 同値の content prop) は
 * `getValue() === content` で検出して何もしない。ここで return しないと、1 打鍵ごとに
 * decoration クリアとスクロールリセットが走って編集にならない。
 */
watch(
  () => [props.content, props.filePath] as const,
  async ([, filePath], [, oldFilePath]) => {
    if (editor === undefined) {
      // 初期 setup の進行中は onMounted 側が最新 props で作るため何もしない。
      // 前回 setup が失敗している場合はここで再試行する。単一コンポーネントでファイル跨ぎに
      // remount されないため、再試行しないと 2 ファイル目以降が無通知のプレーンテキストに
      // 沈黙し続ける (grammar 起因の失敗なら別ファイル = 別言語で回復しうる)
      if (!setupFailed) return;
      const el = containerRef.value;
      if (el === undefined) return;
      await trySetupEditor(el);
      return;
    }
    const fileChanged = filePath !== oldFilePath;
    const valueChanged = editor.getValue() !== props.content;
    if (!fileChanged && !valueChanged) return;
    activeDecorations?.clear();
    if (valueChanged) editor.setValue(props.content);
    if (fileChanged) {
      const myEpoch = ++langEpoch;
      const result = await tryCatch(
        (async () => {
          // monacoSetup は初回 mount で評価済みのため、この import は同期的に解決する
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
      if (editor === undefined || myEpoch !== langEpoch) return;
      const model = editor.getModel();
      if (model) result.value.monaco.editor.setModelLanguage(model, result.value.language);
    }
    if (props.lineNumber !== undefined) {
      revealLine(props.lineNumber);
    } else {
      editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    }
  },
);

/**
 * 読み取り専用 ↔ 編集可能の切替 (Current ↔ Original タブ等)。エディタを remount せず
 * オプションだけ切り替えることで、スクロール位置と undo 履歴を保つ。
 */
watch(
  () => props.editable,
  (editable) => {
    editor?.updateOptions({
      readOnly: !editable,
      domReadOnly: !editable,
      renderLineHighlight: editable ? "line" : "none",
      ariaLabel: editable ? "Edit file contents" : "File contents",
    });
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

/**
 * フォント設定のライブ追従。旧実装 (Shiki HTML) はラッパの CSS 継承で設定変更が即反映されて
 * いたが、Monaco はオプション経由でしか反映されないため watch で追従する。
 * 未設定 (0 / 空文字) は undefined を渡して Monaco のデフォルトへ戻す (updateOptions は
 * undefined 値を「デフォルトに戻す」として validate する)。
 */
watch([previewFontSize, previewCodeFontFamily], ([size, family]) => {
  editor?.updateOptions({
    fontSize: size > 0 ? size : undefined,
    fontFamily: family || undefined,
  });
});
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
