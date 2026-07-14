<doc lang="md">
pin されたファイルプレビュー 1 件のフローティングウィンドウ。

「view の切り離し」なので UI は本体 preview と同一部品で組む: モード切替 / Preview /
Wrap は本体の PreviewToolbar、本文 leaf 切替は本体と共有の PreviewContent (表示 SSOT)。
本体との違いはデータ源だけ — 本体は global selection に結合した `usePreviewContent`
(live)、こちらは pin 時に焼き込んだ raw source (`doc` = current / original の 2 rev
テキスト) で、mode / preview / wrap は window ローカルの view 状態 (初期値は pin 時点の
本体の状態)。編集 / blame / 行番号 reveal は選択文脈に紐づく機能のため capability を
無効のまま使う。markdown 内リンクのナビゲーションは本体 preview 側
(`usePreviewStore.forceSelect`) へ流れる既存挙動のまま。

ドラッグ / リサイズ / クランプ / 初期サイズ換算は汎用シェル FloatingWindow に委譲。
ヘッダは PinnedLogWindow と同じ 2 段構成 (上段: repo アイコン + repo 名 + worktree
branch / 下段: file icon + ファイル名) で、worktree 切替を跨いで生存するウィンドウの
出自を識別する。repo 未解決 (worktree 外の絶対パス等) は上段ごと省く。

ヘッダの open ボタンで pin 元の選択 (`source`) を本体 preview として開き直せる。
worktree 由来は gozdOpen と同じ setOpen → forceSelect のシーケンスで「worktree 切替 +
filer reveal + preview 表示」になり、git / working tree に追従する live な文脈
(編集・blame 含む) はこちらで得る。開けたらウィンドウは閉じる (本体への昇格であり
二重表示を残さない。pin 時に popover を閉じるのと対称)。pin 元 worktree が閉じられて
いる場合はエラートーストで可視化し、ウィンドウは残す。

画像 (image / svg) も doc の snapshot (バイナリは bytes、SVG はテキスト) から表示する
(ImagePreview が Blob → ObjectURL に変換)。テキストと同じく pin 時点の内容に固定され、
pin 後のファイル削除・変更・worktree 消失に影響されない。`<img>` の描画失敗 (壊れた bytes 等)
は error 表示に切り替え、mode / Preview トグルの操作でリセットする。
</doc>

<script setup lang="ts">
import type { WireBytes } from "@gozd/rpc";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { getFileIconUrl } from "../filer";
import { FloatingWindow } from "../floating-window";
import { RepoIcon } from "../repo-icon";
import { useWorktreeStore } from "../worktree";
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

// ==== PreviewContent への入力導出 (raw source + view 状態) ====

// doc は pin 後不変なので setup 時に確定できる
const doc = props.preview.doc;
const fileType = detectFileType(doc.filePath);
const isImageFile = fileType === "image" || fileType === "svg";
/** current / original のテキスト面。バイナリ (bytes) は undefined (本体の currentText / originalText 相当) */
const currentText = typeof doc.current === "string" ? doc.current : undefined;
const originalText = typeof doc.original === "string" ? doc.original : undefined;

/** activeMode 解決済みの表示対象 (union のまま。本体の displayRaw 相当)。 */
const displayRaw = computed(() => (activeMode.value === "original" ? doc.original : doc.current));

/** activeMode 解決済みの表示テキスト (本体の displayContent 相当)。バイナリは undefined。 */
const displayContent = computed<string | undefined>(() =>
  typeof displayRaw.value === "string" ? displayRaw.value : undefined,
);

/** バイナリ判定は content の型そのものが SSOT (本体の displayIsBinary 相当)。 */
const displayIsBinary = computed(() => displayRaw.value instanceof Uint8Array);

/**
 * 画像表示の中身 (本体の imageSource 相当: previewEnabled off / 非画像は undefined)。
 * doc の snapshot から導出するため pin 時点の内容に固定される。
 */
const imageSource = computed<string | WireBytes | undefined>(() => {
  if (!isImageFile || !previewEnabled.value) return undefined;
  return displayRaw.value;
});

/** 画像描画失敗 (壊れた bytes 等) の error 表示。view 操作でリセットする。 */
const imageError = ref(false);
watch([activeMode, previewEnabled], () => {
  imageError.value = false;
});
const contentError = computed<string | undefined>(() =>
  imageError.value ? "Failed to load image" : undefined,
);

/**
 * pin 元の選択を本体 preview として開き直す (doc 参照)。worktree 由来は
 * setOpen → forceSelect の順で呼ぶ: usePreviewStore の dir watch (flush: 'sync') が
 * setOpen の dir 切替と同期で close を消化し、続く forceSelect の open が最終状態として
 * 残る (useGozdOpenHandler と同じシーケンス)。
 */
function openInPreview() {
  const source = props.preview.source;
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
         画像は union のまま渡し、binary 判定は content の型から導出する (本体と同じ規律) -->
    <PreviewContent
      class="min-h-0 flex-1 select-text"
      :file-path="doc.filePath"
      :file-type="fileType"
      :active-mode="activeMode"
      :preview-enabled="previewEnabled"
      :word-wrap="wordWrap"
      :original-content="originalText"
      :diff-current="currentText"
      :code-content="displayContent"
      :display-content="displayContent"
      :image-source="imageSource"
      :display-is-binary="displayIsBinary"
      :error="contentError"
      @image-error="imageError = true"
    />
  </FloatingWindow>
</template>
