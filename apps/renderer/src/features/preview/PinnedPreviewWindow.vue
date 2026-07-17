<doc lang="md">
pin されたファイルプレビュー 1 件のフローティングウィンドウ。

「view の切り離し」なので UI は本体 preview と同一部品で組み、縮小版・独自 UI を作らない。
本体との違いはデータ源 — 本体は global selection に結合した live な取得層、こちらは
pin 元の source (実ファイル参照) + window ローカルの view / 編集状態 (初期値は pin 時点の
本体の状態)。blame / 行番号 reveal は選択文脈に紐づく機能のため capability を無効のまま使う。

## current 側の live 追従と編集

current 側は pin 時 snapshot を初期値に、以後は source の実ファイルに追従する。ただし
`currentIsWorkingTree=false` の pin (過去 rev の歴史表示。commit / 範囲選択で newer が
実 hash) は current が実ファイルの内容ではないため、live 追従も編集もせず pin 時
snapshot に固定する — 過去の内容で実ファイルを上書き保存する事故を構造的に防ぐ:

- source の kind を問わず絶対パスに解決 (worktree は `joinAbsRel`) して自前の単一ファイル
  watch (`rpcFsWatchFileAbsolute`。mount で watch / unmount で解除) + `fsChangeAbsolute`
  購読で再取得する。fsChange (fsWatchSync) に相乗りしないのは、pinned window は repo /
  worktree を閉じても生存する契約のため — sidebar の watch 集合に依存すると閉じた瞬間に
  snapshot へ degrade してしまう。読み書きも同じ絶対パスで統一する
  (`rpcFsReadFileAbsolute` / `rpcFsWriteFileAbsolute`)
- original (比較元 rev) 側は pin 時点に固定のまま。live な git 文脈 (rev 解決・blame) は
  ヘッダの open ボタンで本体 preview に昇格して得る
- 編集は window ローカルの draft / save (本体の editStore とは独立した per-window
  セッション)。dirty の間は外部変更で上書きしない (本体と同じ dirty 保護)。Original
  タブは履歴表示のため編集対象外
- 再取得が notFound / 失敗のときは直前の内容を維持する (pin 後のファイル削除・worktree
  消失でもウィンドウは生存する既存契約)

ドラッグ / リサイズ / クランプ / 初期サイズ換算は汎用シェル FloatingWindow に委譲。
ヘッダには pin 時点の出自 (repo / branch / ファイル名) を焼き込む — worktree 切替を
跨いで生存するウィンドウを識別するため。repo 未解決 (worktree 外の絶対パス等) は
出自の段ごと省く。

ヘッダの open ボタンで pin 元の選択を本体 preview として開き直せる。開けたらウィンドウは
閉じる (本体への昇格であり二重表示を残さない。pin 時に popover を閉じるのと対称)。pin 元
worktree が閉じられている場合はエラートーストで可視化し、ウィンドウは残す。

画像描画失敗は error 表示に切り替え、view 操作・内容更新でリセットする。
</doc>

<script setup lang="ts">
import type { WireBytes } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { computed, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import {
  getFileIconUrl,
  rpcFsReadFileAbsolute,
  rpcFsUnwatchFileAbsolute,
  rpcFsWatchFileAbsolute,
  rpcFsWriteFileAbsolute,
} from "../filer";
import type { FsChangeAbsolutePayload } from "../filer";
import { FloatingWindow } from "../floating-window";
import { RepoIcon } from "../repo-icon";
import { joinAbsRel, useWorktreeStore } from "../worktree";
import PreviewContent from "./PreviewContent.vue";
import { detectFileType } from "./previewFileType";
import type { PreviewMode } from "./previewMode";
import PreviewToolbar from "./PreviewToolbar.vue";
import { usePinnedPreview, type PinnedPreview } from "./usePinnedPreview";
import { usePreviewStore } from "./usePreviewStore";
import IconLucideArrowUpRight from "~icons/lucide/arrow-up-right";

interface Props {
  preview: PinnedPreview;
}

const props = defineProps<Props>();
const { close, move, bringToFront, takeHandoff } = usePinnedPreview();
const worktreeStore = useWorktreeStore();
const repoStore = useRepoStore();
const previewStore = usePreviewStore();
const notification = useNotificationStore();

// preview ヘッダのドラッグから pin された場合の引き継ぎ。one-shot 消費 (PinnedLogWindow と同じ)。
const handoff = takeHandoff(props.preview.id);

const iconUrl = computed(() => getFileIconUrl(props.preview.fileName));

// ==== view 状態 (window ローカル。初期値は pin 時点の本体の状態) ====

const modes = props.preview.modes;
const activeMode = ref<PreviewMode>(
  modes.includes(props.preview.activeMode) ? props.preview.activeMode : (modes[0] ?? "current"),
);
const previewEnabled = ref(props.preview.previewEnabled);
const wordWrap = ref(props.preview.wordWrap);

// ==== PreviewContent への入力導出 (source + view 状態) ====

// doc (pin 時 snapshot) は current 側の初期値。original 側は pin 後も不変
const doc = props.preview.doc;
const source = props.preview.source;
/** live 追従・読み書きの対象 (source を絶対パスに解決したもの)。kind を問わずこれ 1 本で扱う */
const sourceAbsPath =
  source.kind === "absolute" ? source.absPath : joinAbsRel(source.dir, source.relPath);
const fileType = detectFileType(doc.filePath);
const isImageFile = fileType === "image" || fileType === "svg";

/** current 側の中身。pin 時 snapshot を初期値に、source の実ファイル変更へ追従する */
const current = ref<string | WireBytes | undefined>(doc.current);
/** current / original のテキスト面。バイナリ (bytes) は undefined (本体の currentText / originalText 相当) */
const currentText = computed(() => (typeof current.value === "string" ? current.value : undefined));
const originalText = typeof doc.original === "string" ? doc.original : undefined;

/** activeMode 解決済みの表示対象 (union のまま。本体の displayRaw 相当)。 */
const displayRaw = computed(() => (activeMode.value === "original" ? doc.original : current.value));

/** activeMode 解決済みの表示テキスト (本体の displayContent 相当)。バイナリは undefined。 */
const displayContent = computed<string | undefined>(() =>
  typeof displayRaw.value === "string" ? displayRaw.value : undefined,
);

/** バイナリ判定は content の型そのものが SSOT (本体の displayIsBinary 相当)。 */
const displayIsBinary = computed(() => displayRaw.value instanceof Uint8Array);

/**
 * 画像表示の中身 (本体の imageSource 相当: previewEnabled off / 非画像は undefined)。
 */
const imageSource = computed<string | WireBytes | undefined>(() => {
  if (!isImageFile || !previewEnabled.value) return undefined;
  return displayRaw.value;
});

/** 画像描画失敗 (壊れた bytes 等) の error 表示。view 操作・内容更新でリセットする。 */
const imageError = ref(false);
watch([activeMode, previewEnabled, current], () => {
  imageError.value = false;
});
const contentError = computed<string | undefined>(() =>
  imageError.value ? "Failed to load image" : undefined,
);

// ==== 編集 (window ローカルの per-window セッション) ====

/** 未保存の編集。undefined = 編集なし。本体の editStore とは独立した window ローカル状態 */
const draft = ref<string>();
const saving = ref(false);
const isDirty = computed(() => draft.value !== undefined && draft.value !== currentText.value);

/**
 * 編集可否。current 側が working tree でない pin (過去 rev の歴史表示) は全面不可 —
 * 保存すると過去の内容で実ファイルを上書きしてしまうため。Original タブは pin 時
 * snapshot の履歴表示なので対象外 (本体の「編集可能なのは current だけ」whitelist と
 * 同じ向き。diff の編集面は current 側のみ)。バイナリ / 画像は editable を消費する
 * leaf (CodePreview / DiffPreview) 自体が描画されないため条件に含めない。
 */
const editable = computed(
  () =>
    props.preview.currentIsWorkingTree &&
    activeMode.value !== "original" &&
    currentText.value !== undefined,
);

/** コード leaf / diff current に渡す内容 (draft 込み。本体 PreviewPane の codeContent と同じ形) */
const codeContent = computed<string | undefined>(() => {
  if (!editable.value) return displayContent.value;
  return draft.value ?? displayContent.value;
});
const diffCurrent = computed<string | undefined>(() => {
  if (!editable.value) return currentText.value;
  return draft.value ?? currentText.value;
});

function discardEdit() {
  draft.value = undefined;
}

async function saveEdit() {
  const content = draft.value;
  if (content === undefined || !isDirty.value || saving.value) return;
  saving.value = true;
  const result = await tryCatch(rpcFsWriteFileAbsolute({ absolutePath: sourceAbsPath, content }));
  saving.value = false;
  if (!result.ok) {
    notification.error(`Failed to save ${props.preview.fileName}`, result.error);
    return;
  }
  current.value = content;
  draft.value = undefined;
}

// ==== current 側の live 追従 ====

/** 非同期レース防止のバージョンカウンター (本体 usePreviewContent と同じ規律) */
let fetchVersion = 0;

async function refetchCurrent() {
  // dirty の間は外部変更で上書きしない (本体の fsChange と同じ dirty 保護)
  if (isDirty.value) return;
  const version = ++fetchVersion;
  const result = await tryCatch(
    rpcFsReadFileAbsolute({ absolutePath: sourceAbsPath }).then((r) => r.result),
  );
  if (version !== fetchVersion) return;
  // 再取得失敗 / notFound (削除等) は直前の内容を維持する (ウィンドウ生存契約)
  if (!result.ok) return;
  const file = result.value;
  if (file === undefined || file.notFound || file.isDirectory) return;
  current.value = file.content;
  draft.value = undefined;
}

// window が生きている間だけ main に単一ファイル watch を張る (sourceAbsPath は不変)。
// fsChange (fsWatchSync) に相乗りしない理由は doc 参照。
// current 側が working tree でない pin (過去 rev の歴史表示) は追従対象がそもそも無いため
// watch も購読も張らず、pin 時 snapshot に固定する。
if (props.preview.currentIsWorkingTree) {
  void tryCatch(rpcFsWatchFileAbsolute({ absolutePath: sourceAbsPath })).then((result) => {
    // watch 失敗は live 追従が効かないだけで snapshot 表示は成立するため、ログに残す
    if (!result.ok) {
      console.error(`[PinnedPreviewWindow] watch failed: ${sourceAbsPath}: ${result.error}`);
    }
  });
  onUnmounted(() => void tryCatch(rpcFsUnwatchFileAbsolute({ absolutePath: sourceAbsPath })));
  const unsubscribeFileChange = onMessage<FsChangeAbsolutePayload>(
    "fsChangeAbsolute",
    ({ path }) => {
      if (path !== sourceAbsPath) return;
      void refetchCurrent();
    },
  );
  onUnmounted(unsubscribeFileChange);
}

/**
 * pin 元の選択を本体 preview として開き直す (doc 参照)。worktree 由来は
 * setOpen → forceSelect の順で呼ぶ: usePreviewStore の dir watch (flush: 'sync') が
 * setOpen の dir 切替と同期で close を消化し、続く forceSelect の open が最終状態として
 * 残る (useGozdOpenHandler と同じシーケンス)。
 */
function openInPreview() {
  if (source.kind === "absolute") {
    previewStore.forceSelect({ kind: "absolute", absPath: source.absPath });
    close(props.preview.id);
    return;
  }
  // pin 元 worktree が閉じられた / 削除された後は開き先が無い。silent no-op にせず、
  // snapshot (ウィンドウ) も残す — 開けなかったのに表示だけ失う状態を作らない
  if (repoStore.findRepoOwning(source.dir) === undefined) {
    notification.error("Worktree is no longer open");
    return;
  }
  worktreeStore.setOpen(source.dir);
  previewStore.forceSelect({ kind: "worktreeRelative", relPath: source.relPath });
  // 本体 preview へ昇格したらウィンドウは役目を終える (二重表示を残さない。
  // pin 時に popover を閉じるのと対称の規律)
  close(props.preview.id);
}
</script>

<template>
  <FloatingWindow
    :x="preview.x"
    :y="preview.y"
    :z="preview.z"
    :body-width="preview.bodyWidth"
    :body-height="preview.bodyHeight"
    :handoff="handoff"
    @move="(x, y) => move(preview.id, x, y)"
    @activate="bringToFront(preview.id)"
    @close="close(preview.id)"
  >
    <!-- PinnedLogWindow と同じ 2 段構成 (上段: repo アイコン + repo 名 + branch / 下段:
         ファイル)。repo 未解決 (空文字) は上段ごと省く。 -->
    <template #header>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div v-if="preview.repoName !== ''" class="flex items-center gap-2">
          <RepoIcon :name="preview.repoName" :owner="preview.repoOwner" />
          <span class="shrink-0 truncate text-xs font-semibold tracking-wide">
            {{ preview.repoName }}
          </span>
          <span
            v-if="preview.branch !== ''"
            class="min-w-0 flex-1 truncate text-xs text-foreground-low"
          >
            {{ preview.branch }}
          </span>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <img :src="iconUrl" class="size-4 shrink-0" alt="" />
          <span class="min-w-0 truncate text-xs font-semibold" :title="preview.displayPath">
            {{ preview.fileName }}
          </span>
        </div>
      </div>
    </template>

    <!-- pin 元を本体 preview として開き直す (wt 切替 + filer reveal)。シェルの close と
         同一グループ (ヘッダ右上) に集約する -->
    <template #actions>
      <button
        type="button"
        aria-label="Open in preview"
        title="Open in preview"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @pointerdown.stop
        @click="openInPreview()"
      >
        <IconLucideArrowUpRight class="size-3.5" />
      </button>
    </template>

    <!-- 本体と同一のツールバー (モードタブ + Preview / Wrap)。state だけ window ローカル -->
    <PreviewToolbar
      v-model:active-mode="activeMode"
      v-model:preview-enabled="previewEnabled"
      v-model:word-wrap="wordWrap"
      class="shrink-0"
      :modes="modes"
      :original-hash-label="preview.originalHashLabel"
      :file-type="fileType"
    />

    <!-- 本文 leaf 切替も本体と共有の PreviewContent。テキスト面 (code / diff) は string、
         画像は union のまま渡し、binary 判定は content の型から導出する (本体と同じ規律)。
         保存ツールバーは本体 PreviewPane と同じ「未保存の変更があるときだけ Discard/Save を
         フローティング表示」(relative ラッパー基準で右上固定) -->
    <div class="relative min-h-0 flex-1">
      <div
        v-if="editable && isDirty"
        class="absolute top-2 right-4 z-10 flex h-7 items-center gap-2 rounded-md border border-border bg-panel px-2 shadow-sm"
      >
        <button
          type="button"
          class="text-xs text-foreground-low hover:text-foreground"
          title="Discard changes"
          aria-label="Discard changes"
          @click="discardEdit()"
        >
          Discard
        </button>
        <button
          type="button"
          class="rounded-sm bg-primary px-2 py-0.5 text-xs text-foreground hover:bg-primary-hover disabled:bg-element disabled:text-foreground-muted disabled:hover:bg-element"
          :disabled="saving"
          title="Save"
          aria-label="Save"
          @click="saveEdit()"
        >
          Save
        </button>
      </div>

      <PreviewContent
        class="size-full select-text"
        :file-path="doc.filePath"
        :file-type="fileType"
        :active-mode="activeMode"
        :preview-enabled="previewEnabled"
        :word-wrap="wordWrap"
        :original-content="originalText"
        :diff-current="diffCurrent"
        :code-content="codeContent"
        :display-content="displayContent"
        :image-source="imageSource"
        :display-is-binary="displayIsBinary"
        :error="contentError"
        :editable="editable"
        @update-content="draft = $event"
        @image-error="imageError = true"
      />
    </div>
  </FloatingWindow>
</template>
