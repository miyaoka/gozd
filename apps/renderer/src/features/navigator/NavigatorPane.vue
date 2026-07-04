<doc lang="md">
Filer（上）と Changes（下）を垂直分割で表示するコンテナ。

## 動作

- Filer が flex-1 で残りスペースを取り、Changes が固定高さ
- ResizeHandle で上下の比率をリサイズ可能
- git リポジトリでない場合は Filer のみ表示
- FilerPane の reveal は worktreeStore.revealVersion を内部で購読しているため props 経由不要
- FilerPane / ChangesPane の `select` emit はどちらも user-initiated select として `previewStore.requestSelect` を呼ぶ。同一パス再選択でのトグル close / summary 抜けの意思決定は preview store 側に集約されている（[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）
- Filer ヘッダーの状態表示は `headerStatus` 1 つの computed に集約する。snapshot mode（`gitGraphStore.selectedHash` が `UNCOMMITTED_HASH` 以外）では選択中コミットの日時（`formatCompactTime` の狭幅向け compact 表示、tooltip に `formatAbsoluteTime` の絶対時刻）、working tree mode では固定テキスト `"(now)"` を同じ span で描画する。working tree mode を時刻でなく固定ラベルにするのは、"Now" ボタンを押した遷移先が何であるかを明示するため（変更ファイルの mtime を出すと「今」であることが伝わりにくい）
- snapshot mode 中は "Now" ボタンも表示する。表示条件は `gitGraphStore.selectedHash !== UNCOMMITTED_HASH` 単独（日時解決の成否とは独立。commits ウィンドウ未ロード中でも "Now" は出る）。クリックで `gitGraphStore.select(UNCOMMITTED_HASH)` を呼び working tree 表示に戻す（GitGraphPane の Working Tree 行クリックと同一経路）

## 右クリックメニュー

FilerPane / ChangesPane (および配下の TreeItem) から `contextMenu` event を受けて singleton popover (`useFileContextMenu`) に橋渡しする。子側は navigator への直接依存を持たない (payload 型のみ type-only import) ため、依存方向は navigator → 子の 1 方向で閉じる。pointerup once-capture による light-dismiss 回避 / dir / hash snapshot / disconnect ガード等の内部仕様は `useFileContextMenu.ts` の docstring を SSOT として参照する。
</doc>

<script setup lang="ts">
import { useElementSize, useEventListener } from "@vueuse/core";
import { computed, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { formatAbsoluteTime, formatCompactTime } from "../../shared/time";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { ResizeHandle } from "../layout";
import { usePreviewStore } from "../preview";
import { useServerStore } from "../server";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import FileContextMenu from "./FileContextMenu.vue";
import { useFileContextMenu } from "./useFileContextMenu";
import type { FileContextMenuPayload } from "./useFileContextMenu";
import IconLucideFolderTree from "~icons/lucide/folder-tree";
import IconLucideServer from "~icons/lucide/server";

const HANDLE_HEIGHT = 8;
const FILER_MIN_HEIGHT = 100;
const CHANGES_MIN_HEIGHT = 60;

const repoStore = useRepoStore();
const previewStore = usePreviewStore();
const filerWrapperRef = useTemplateRef<HTMLElement>("filerWrapper");
const containerRef = useTemplateRef<HTMLElement>("container");
const { height: containerHeight } = useElementSize(containerRef);

const changesHeight = ref(360);

// コンテナ縮小時に changesHeight をクランプ（Filer が潰れるのを防ぐ）
// useElementSize は mount 直後 0 を返すため、計測前は clamp をスキップする。
// watch source は外因（containerHeight）だけにする。changesHeight は書き換え対象なので
// source に含めると再帰発火経路が混入する（user resize は別ロジックでクランプ済み）。
watch(
  containerHeight,
  (h) => {
    if (h <= 0) return;
    const maxChanges = h - FILER_MIN_HEIGHT - HANDLE_HEIGHT;
    if (changesHeight.value > maxChanges) {
      changesHeight.value = Math.max(CHANGES_MIN_HEIGHT, maxChanges);
    }
  },
  { immediate: true },
);

/** Filer ペインの DOM 実測高さ（flex-1 のため v-model 不可） */
function getFilerHeight(): number {
  return filerWrapperRef.value?.offsetHeight ?? FILER_MIN_HEIGHT;
}

function onFileSelect(relPath: string) {
  previewStore.requestSelect({ kind: "worktreeRelative", relPath });
}

const { open: openFileContextMenu } = useFileContextMenu();
const gitGraphStore = useGitGraphStore();
const worktreeStore = useWorktreeStore();
const notification = useNotificationStore();
const serverStore = useServerStore();

// Filer の snapshot mode UI (状態表示 + "Now" ボタン) を出すべきか。headerStatus と
// "Now" ボタンはこれ 1 つだけを見る (1 つの判定が 2 箇所に分岐して食い違うのを防ぐ)。
// - gitGraphStore.isSnapshotMode: FilerPane.snapshotHash と共通の SSOT (selectedHash
//   単独判定、範囲選択は scope 外)
// - repoStore.selectedIsGitRepo: 非 git project は git-graph 自体が mount されず
//   「過去か現在か」という概念が存在しないため合わせて隠す
// snapshotCommit (下記) は commits ウィンドウ未ロード等で解決できないことがあるが、
// その間も snapshot mode 自体は継続しているため、日時表示が無くても "Now" は出し続ける。
const isSnapshotMode = computed(() => repoStore.selectedIsGitRepo && gitGraphStore.isSnapshotMode);

// snapshot 表示中の commit 詳細 (日時等)。commits ウィンドウ内に無ければ undefined
// (ロード中 / reload で一時的に外れた場合)。日時表示のみこれで gate する。
const snapshotCommit = computed(() => {
  if (!gitGraphStore.isSnapshotMode) return undefined;
  const idx = gitGraphStore.hashToIndex.get(gitGraphStore.selectedHash);
  return idx !== undefined ? gitGraphStore.commits[idx] : undefined;
});

/**
 * ヘッダーに出す状態表示 1 つの SSOT。snapshot mode では選択中コミットの日時、
 * working tree mode では固定テキスト "(now)" を指す。"Now" ボタンを押した遷移先が
 * 何であるかを、時刻情報ではなく状態ラベルとして明示する。
 *
 * 非 git project（git-graph 自体が mount されず snapshot mode が存在しない）では
 * 表示しない。git リポジトリでの「過去か現在か」という概念がそもそも無いため。
 */
const headerStatus = computed<{ text: string; title?: string } | undefined>(() => {
  if (!repoStore.selectedIsGitRepo) return undefined;
  if (!isSnapshotMode.value) return { text: "(now)" };
  const commit = snapshotCommit.value;
  if (commit === undefined) return undefined;
  return {
    text: formatCompactTime(commit.date),
    title: `${commit.shortHash} · ${formatAbsoluteTime(commit.date)}\n${commit.message}`,
  };
});

// snapshot 表示から working tree (最新 = "Now") に戻す。git-graph の「Working Tree」行
// クリックと同一経路 (user-initiated select、compareHash クリア)。
function goToNow() {
  gitGraphStore.select(UNCOMMITTED_HASH);
}

type PendingOpen = {
  payload: FileContextMenuPayload;
  dir: string;
  hash: string | undefined;
};

/**
 * 右クリックで積まれる pending open。次の `pointerup` で処理して open する。
 * 連打時は最後の右クリックが pending を上書き (popover singleton の openState 上書き
 * semantics と整合 — 最後の値だけが意味を持つ)。cancel を log しないのは意図的:
 * user 連打のたびに console を汚すノイズになるため、観察可能性より signal-to-noise を優先する。
 */
const pendingOpen = ref<PendingOpen | null>(null);

/**
 * window 全体に常設する `pointerup` capture listener。pending が積まれていれば消化して open する。
 *
 * **不変条件 (実装変更時に必読)**:
 * - `setTimeout(0)` / `requestAnimationFrame` / `queueMicrotask` 等の task / microtask defer は
 *   `popover="auto"` light-dismiss を **抜けない** (WebKit shell 期に実機検証済)。続く mouseup が
 *   popover に到達して即 dismiss される (whatwg/html#10905)
 * - `pointerup` を `capture: true` で window に貼ると、popover が show される **前** に listener が
 *   pointerup を消化する → 続く mouseup は popover open 前の press cycle として扱われ
 *   light-dismiss の対象外になる。`{ capture: true }` を外したり、pointerdown / mousedown 経路に
 *   変えてはならない
 * - `event.button === 2` のような button filter を入れてはならない。macOS WebKit は control+click
 *   を button=0 として dispatch する (bugzilla 52174) ため、control+click 経由の native context
 *   menu 経路で menu が開かなくなる
 * - `pointerdown` で pending を reset する経路を追加してはならない。右クリック sequence
 *   (pointerdown → contextmenu → pointerup) では右ボタン pointerdown が `onFileContextMenu`
 *   の pending 積みより前に終わるため、pointerdown reset を入れても右クリック単体では
 *   破綻しない。しかし pending が積まれた状態で **別経路の pointerdown** (例: 左 click) が
 *   来ると pending を即消去してしまい、本来意図した次の pointerup での消化が起きなくなる。
 *   状態遷移を pointerup のみで完結させる現設計を維持すること
 * - keyboard 経路 (Shift+F10 / Apps key) と programmatic dispatch は pointerup が発火しないため
 *   menu は開かない。本 PR の責務外で、将来 keyboard ショートカット要件が発生したら別経路
 *   ([docs/keybinding.md](../../../../../docs/keybinding.md)) で menu を開く
 *
 * `useEventListener` を setup 直下で呼ぶことで effect scope に紐付き、unmount / HMR で自動 cleanup
 * される (handler 内で呼ぶと scope に登録されず leak する)。
 */
useEventListener(
  window,
  "pointerup",
  () => {
    // `event.button` で右クリック (=2) のみに絞らない理由: macOS WebKit は control + click を
    // **button=0** として dispatch する (webkit bugzilla 52174, "RESOLVED INVALID" だが挙動は
    // 残っている)。button 絞り込みを入れると macOS native の context menu 経路 (control+click)
    // で menu が開かなくなる。pending ref そのものが「直前に contextmenu があった」flag を
    // 兼ねるため、最初の pointerup で消化 + null 化する設計で十分。多ボタン同時押し race
    // (右クリック保持中に別所で左 click) は edge case として受容する
    const pending = pendingOpen.value;
    if (!pending) return;
    pendingOpen.value = null;
    if (!pending.payload.anchorEl.isConnected) {
      notification.debug("[FileContextMenu] anchor disconnected before open, skipping", {
        relPath: pending.payload.relPath,
      });
      return;
    }
    openFileContextMenu(pending.payload.anchorEl, {
      dir: pending.dir,
      relPath: pending.payload.relPath,
      commitHash: pending.hash,
      x: pending.payload.x,
      y: pending.payload.y,
    });
  },
  { capture: true },
);

/**
 * 配下から bubble してくる contextmenu request を pending に積む。
 *
 * - `dir` / `commitHash` は **本関数の同期実行時点** で snapshot する。pointerup 待機中に
 *   worktree 切替 / commit 選択切替が起きても、その右クリック時点の値を popover context に
 *   焼き付けることで「古い relPath + 新 dir」「古い anchor + 新 hash」の race を構造的に排除する
 * - `dir` 未設定 (起動初期 / 全 repo 閉鎖直後) では menu を出さず debug log。FilerPane は
 *   `v-if="!dir"` で "waiting for open command..." を出してツリー自体を描画しないため、user
 *   操作経路ではこの分岐に到達しない (defensive)。観測対象が user 不可視の異常系なので
 *   `info` toast ではなく `debug` のまま (toast にすると正常状態と区別しにくい)
 */
function onFileContextMenu(req: FileContextMenuPayload) {
  const dirSnapshot = worktreeStore.dir;
  if (dirSnapshot === undefined) {
    notification.debug("[FileContextMenu] no active worktree, skipping", { relPath: req.relPath });
    return;
  }
  pendingOpen.value = {
    payload: req,
    dir: dirSnapshot,
    hash: gitGraphStore.contextMenuHash,
  };
}
</script>

<template>
  <div
    ref="container"
    class="flex size-full flex-col overflow-hidden border-l border-border bg-background text-foreground"
  >
    <!-- Filer -->
    <div ref="filerWrapper" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <span class="flex shrink-0 items-center gap-1 text-xs font-semibold text-foreground">
          <IconLucideFolderTree class="size-3.5" />
          Files
        </span>
        <span
          v-if="headerStatus"
          class="min-w-0 flex-1 truncate text-xs text-foreground-low"
          :title="headerStatus.title"
        >
          {{ headerStatus.text }}
        </span>
        <button
          v-if="isSnapshotMode"
          type="button"
          class="ml-auto shrink-0 rounded-sm border border-border px-1.5 py-1 text-xs text-foreground-low hover:bg-element-hover hover:text-foreground"
          title="Jump to latest (working tree)"
          @click="goToNow"
        >
          Now
        </button>
        <!-- Running servers パネルのトグル。Swift 期は native titlebar の ToolbarItem
             だったが、Electron shell は native toolbar を持たないためアプリ右上に相当する
             この位置に置く -->
        <button
          type="button"
          class="ml-auto shrink-0 rounded-sm p-1 hover:bg-element-hover"
          :class="
            serverStore.isOpen ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
          "
          title="Running servers"
          @click="serverStore.toggle()"
        >
          <IconLucideServer class="size-3.5" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-hidden">
        <FilerPane @select="onFileSelect" @context-menu="onFileContextMenu" />
      </div>
    </div>

    <!-- Changes（git リポジトリのみ） -->
    <template v-if="repoStore.selectedIsGitRepo">
      <ResizeHandle
        v-model:after-size="changesHeight"
        direction="vertical"
        :before-min-size="FILER_MIN_HEIGHT"
        :after-min-size="CHANGES_MIN_HEIGHT"
        :get-before-size="getFilerHeight"
      />
      <div class="shrink-0 overflow-hidden" :style="{ height: `${changesHeight}px` }">
        <ChangesPane @select="onFileSelect" @context-menu="onFileContextMenu" />
      </div>
    </template>

    <!-- ファイル行の右クリックメニュー (Filer / Changes 共用) -->
    <FileContextMenu />
  </div>
</template>
