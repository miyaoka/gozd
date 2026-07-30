<doc lang="md">
ファイル行の右クリックメニュー。項目 (Open in default app / Copy file / Copy path) は
preview ヘッダの ⋮ メニューと共通の `FileActionMenuItems` (filer) を描画する。
context の組み立てと snapshot semantics、defer / disconnect ガード等の内部仕様は
`useFileContextMenu.ts` の docstring を SSOT として参照する。

Open / Copy file は snapshot mode (context.isSnapshot) では出さない。可視判定の理由は
FileActionMenuItems の doc を参照 (openable prop に反転して渡す)。

## 実体向けの項目 (実体がツリー上のパスと違う行のみ)

項目の一覧と可視条件は [docs/filer.md](../../../../../docs/filer.md#実体を対象にする右クリック項目) が
SSOT。本 component 固有の点だけ:

- 共通の `FileActionMenuItems` には入れない。共有先の preview ヘッダ ⋮ メニューは実体情報を持たず、
  これらは filer の symlink 経路に固有 (共有するのは「どの入口でも同じ意味を持つ項目」に限る)
- file 実体は navigation 意味の経路なので `requestSelect` ではなく `forceSelect` を使う (同一 path でも
  トグル close させない。[docs/preview.md](../../../../../docs/preview.md) の決定表)
- directory 実体は preview がディレクトリを表示できないため `worktreeStore.revealRelPath` で
  **ツリーだけ**移動する (selection は動かさないので開いている preview は保たれる)
- 実体向け項目は context の `dir` snapshot ではなく現在の store 基準で解決するため、dir 切替では
  menu を閉じる (詳細は `watch` 直上のコメント)
</doc>

<script setup lang="ts">
import { computed, watch, type CSSProperties } from "vue";
import { writeClipboardText } from "../../shared/clipboard";
import { useNotificationStore } from "../../shared/notification";
import { FileActionMenuItems } from "../filer";
import { usePreviewStore } from "../preview";
import { joinAbsRel, useWorktreeStore } from "../worktree";
import { useFileContextMenu } from "./useFileContextMenu";
import IconLucideClipboardCopy from "~icons/lucide/clipboard-copy";
import IconLucideCornerUpRight from "~icons/lucide/corner-up-right";

const { Popover, context, close } = useFileContextMenu();
const previewStore = usePreviewStore();
const worktreeStore = useWorktreeStore();
const notify = useNotificationStore();

/** 実体がツリー上のパスと違う行でだけ定義される。実体向け項目の可視判定と対象を兼ねる */
const realTarget = computed(() => context.value?.realTarget);

// dir 切替で menu を閉じる。context の `dir` は右クリック時点の snapshot で、実体向け項目は
// worktree 相対パスを **現在の** dir 基準で解決する (`revealRelPath` / `forceSelect`)。menu が dir
// 切替を生き延びると worktree A で算出した relPath が worktree B に適用され、同名パスが実在する
// 並列 worktree では「別 worktree の同名ファイルが静かに開く」。menu を閉じることで、
// dir 切替時に selection クリア / preview close / ツリー再マウントが走る既存の規律に揃える
// (handler ごとに dir 一致を比較する形は項目追加のたびに判定が分散するため採らない)
watch(
  () => worktreeStore.dir,
  () => close(),
);

/**
 * 実体を選択できるか = 実体が worktree 配下にあるか (`relPath` が定義されている)。worktree 外の実体は
 * filer のツリーに対応ノードが無いため選択が成立しない。選択と path コピーは排他で、
 * 選択できる実体は選択項目、できない実体は `Copy original path` だけを出す。
 */
const canSelectOriginal = computed(() => realTarget.value?.relPath !== undefined);

/**
 * 動詞は `Select` = filer のクリック操作の再現。file 行の click は選択 → preview を開き、folder 行の
 * click は展開なので、kind 別の意味差が filer 側に既にあり、実装 (file は preview 差し替え / folder は
 * ツリーだけ移動) とそのまま対応する。surface 名を書き足す必要が無い。
 */
const selectOriginalLabel = computed(() =>
  realTarget.value?.isDirectory === true ? "Select original folder" : "Select original file",
);

// 各 handler は context を同期 snapshot してから close する (close 後に context が undefined へ
// 倒れても、実行中のアクションは snapshot 済みの値で完走する。FileActionMenuItems と同じ規律)

function handleSelectOriginal() {
  const target = realTarget.value;
  close();
  // worktree 外の実体は選択項目自体を出さない (canSelectOriginal) ため relPath は定義済み
  if (target?.relPath === undefined) return;
  // ディレクトリ実体は preview に流せないのでツリーだけ移動する
  if (target.isDirectory) {
    worktreeStore.revealRelPath(target.relPath);
    return;
  }
  previewStore.forceSelect({ kind: "worktreeRelative", relPath: target.relPath });
}

async function handleCopyOriginalPath() {
  const target = realTarget.value;
  close();
  if (target === undefined) return;
  const result = await writeClipboardText(target.absPath);
  if (!result.ok) {
    notify.error("Failed to copy original path", result.error);
  }
}

/**
 * 右クリック座標 (context.x/y) に置く不可視の 0 サイズ anchor。popover に left/top を直書きすると
 * viewport 右端 / 下端で `position-try-fallbacks` が効かず見切れるため、座標は anchor 要素側に
 * 持たせ、popover は常に CSS Anchor Positioning (position-area + flip fallback) で配置する
 * (BlamePopover の「コンポーネント所有の不可視 anchor を幾何座標に重ねる」方式と同型)。
 * `showPopover({ source })` の implicit anchor (行要素) は positionAnchor 指定で上書きされる。
 */
const originAnchorStyle = computed<CSSProperties | undefined>(() => {
  const ctx = context.value;
  if (ctx === undefined) return undefined;
  return {
    position: "fixed",
    left: `${ctx.x}px`,
    top: `${ctx.y}px`,
    anchorName: "--file-context-menu-origin",
  };
});

// マウス座標 (不可視 anchor) の bottom-right へ出し、viewport 端では flip する
const popoverStyle = {
  position: "fixed",
  positionAnchor: "--file-context-menu-origin",
  positionArea: "block-end span-inline-end",
  positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
};

/** context → FileActionMenuItems props の変換。閉じているときは undefined で項目ごと消す */
const itemProps = computed(() => {
  const ctx = context.value;
  if (ctx === undefined) return undefined;
  return {
    absPath: joinAbsRel(ctx.dir, ctx.relPath),
    displayName: ctx.relPath,
    commitHash: ctx.commitHash,
    openable: !ctx.isSnapshot,
  };
});
</script>

<template>
  <!-- 不可視 anchor は positioned element (popover) より DOM 前方に置く (acceptable anchor 条件) -->
  <div v-if="originAnchorStyle" :style="originAnchorStyle" aria-hidden="true" />
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="popoverStyle"
  >
    <button
      v-if="canSelectOriginal"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
      :title="realTarget?.absPath"
      @click="handleSelectOriginal"
    >
      <IconLucideCornerUpRight class="size-4 shrink-0" />
      {{ selectOriginalLabel }}
    </button>
    <button
      v-if="realTarget && !canSelectOriginal"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
      :title="realTarget.absPath"
      @click="handleCopyOriginalPath"
    >
      <IconLucideClipboardCopy class="size-4 shrink-0" />
      Copy original path
    </button>
    <FileActionMenuItems v-if="itemProps" v-bind="itemProps" @close="close()" />
  </Popover>
</template>
