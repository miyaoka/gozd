<doc lang="md">
ファイル行の右クリックメニュー。項目 (Open in default app / Copy file / Copy path) は
preview ヘッダの ⋮ メニューと共通の `FileActionMenuItems` (filer) を描画する。
context の組み立てと snapshot semantics、defer / disconnect ガード等の内部仕様は
`useFileContextMenu.ts` の docstring を SSOT として参照する。

Open / Copy file は snapshot mode (context.isSnapshot) では出さない。可視判定の理由は
FileActionMenuItems の doc を参照 (openable prop に反転して渡す)。

## 実体向けの項目 (実体がツリー上のパスと違う行のみ)

共通の `FileActionMenuItems` には入れない: 共有先の preview ヘッダ ⋮ メニューは実体情報を持たず、
これらは filer の symlink 経路に固有だから (共有するのは「どの入口でも同じ意味を持つ項目」に限る)。

**移動と path コピーは排他**。判定軸は「filer で開けるか」= 実体が worktree 配下か (`relPath` の
有無) の 1 本だけで、開ける実体は移動項目、開けない実体は `Copy real path` を出す。両方出すと
「どちらを使うべきか」の判断をユーザーに預けることになるため、実体の在り処で 1 つに定める。

- 左クリックと右クリックの対象は分けたままにする。行の click は見えているパスで振る舞い、実体への
  移動は本項目という明示操作でだけ起きる (symlink は 1 つの実体に複数の名前がある構造で、UI が暗黙に
  実体へ正規化すると「どの名前で開いたか」が復元できなくなる)
- 移動先の label は実体の種別で file / folder を出し分ける。行の見た目 (link 自身の名前とアイコン)
  からは実体がファイルかディレクトリか判別できないため
- 実体が file: `worktreeRelative` で preview に出す (ツリー reveal と git 連動が効く)。navigation
  意味の経路なので `requestSelect` ではなく `forceSelect` を使う (同一 path でもトグル close させない。
  [docs/preview.md](../../../../../docs/preview.md) の決定表)
- 実体が directory: preview はディレクトリを表示できないので `worktreeStore.revealRelPath` で
  **ツリーだけ**実体へ移動する (selection は動かさないので開いている preview は保たれる)
- worktree 外の実体は `Copy real path` のみ。既存の `Copy path` は link path を返し続けるので、
  両者は別の値を返す別項目として並ぶ
</doc>

<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
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

/**
 * 実体へ移動できるか = 実体が worktree 配下にあるか (`relPath` が定義されている)。worktree 外の実体は
 * filer のツリーに対応ノードが無いため「移動」が成立しない。移動と path コピーは排他で、
 * 開ける実体は移動項目、開けない実体は `Copy real path` だけを出す。
 */
const canGoToTarget = computed(() => realTarget.value?.relPath !== undefined);

/** 移動先が file / directory のどちらかを label で明示する (行の見た目からは実体の種別が分からない) */
const goToTargetLabel = computed(() =>
  realTarget.value?.isDirectory === true ? "Go to real folder" : "Go to real file",
);

// 各 handler は context を同期 snapshot してから close する (close 後に context が undefined へ
// 倒れても、実行中のアクションは snapshot 済みの値で完走する。FileActionMenuItems と同じ規律)

function handleGoToTarget() {
  const target = realTarget.value;
  close();
  // worktree 外の実体は移動項目自体を出さない (canGoToTarget) ため relPath は定義済み
  if (target?.relPath === undefined) return;
  // ディレクトリ実体は preview に流せないのでツリーだけ移動する
  if (target.isDirectory) {
    worktreeStore.revealRelPath(target.relPath);
    return;
  }
  previewStore.forceSelect({ kind: "worktreeRelative", relPath: target.relPath });
}

async function handleCopyRealPath() {
  const target = realTarget.value;
  close();
  if (target === undefined) return;
  const result = await writeClipboardText(target.absPath);
  if (!result.ok) {
    notify.error("Failed to copy real path", result.error);
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
      v-if="canGoToTarget"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
      :title="realTarget?.absPath"
      @click="handleGoToTarget"
    >
      <IconLucideCornerUpRight class="size-4 shrink-0" />
      {{ goToTargetLabel }}
    </button>
    <button
      v-if="realTarget && !canGoToTarget"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
      :title="realTarget.absPath"
      @click="handleCopyRealPath"
    >
      <IconLucideClipboardCopy class="size-4 shrink-0" />
      Copy real path
    </button>
    <FileActionMenuItems v-if="itemProps" v-bind="itemProps" @close="close()" />
  </Popover>
</template>
