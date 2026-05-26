<doc lang="md">
ファイルツリーの再帰的なノード。

## 動作

- `kind === "directory"` は展開/折りたたみ可能で、初回展開時に RPC で子エントリを遅延読み込み
- material-icon-theme のアイコンを表示
- git status に応じた色分け（modified=黄、added=緑、deleted=赤、renamed=青）と削除ファイルの打ち消し線

## click 経路（kind ごとの差）

- `directory`: 展開 / 折りたたみ
- `file`: `select` emit
- `symlink`: working tree モード (`snapshotHash` undefined) では `select` emit で実 file に resolve。
  snapshot mode では blob 内容が target path 文字列でしかないため click を no-op に倒す
- `submodule`: 常に no-op。gitlink object (`160000`) は `gitShowCommitFile` で内容を取得できないため
  preview に流すとエラーになる。視覚的にも opacity を落として「click できない」ことを示す

## snapshot mode (snapshotHash プロパティが真値のとき)

- `rpcFsReadDir` の代わりに `rpcGitLsTree(dir, hash, path)` で「そのコミット時点の tree」を 1 階層読む
- git change 計算 (`effectiveGitChange` / `textColorClass`) と削除エントリ仮想表示は行わない
  （snapshot tree は git status と無関係 / 過去 commit のため削除概念がない）
- fsChange / gitStatusChange の watch は no-op（snapshot は不変）
- `snapshotHash` 変化を watch して children をクリアし再 load する。展開状態 (expanded) と
  孫ノードの cache は保持され、mode 切替で再マウントしない（FilerPane の `:key` は `dir` のみ）
- mode 切替時は `rpcGitLsTree` 完了まで children を先行 reset せず、旧 mode の tree を表示し続ける。
  Loading フラッシュを毎回見せると「今どこを見ているか」の continuity が壊れるため。race は
  `loadSeq` でガードして古い RPC の結果が新しいものを踏み潰さないようにする
- 子へ `snapshotHash` をそのまま継承する。同一サブツリー全体で mode が揃う
- 子の `v-for :key` は `${child.name}-${child.kind}` で識別。同 path で kind が変わるケース
  (file ↔ directory) は意味変化として別 instance に分けることで、展開可能性の変化を構造的に
  扱う

## ルートノード（worktree 自体を表す不可視ノード）

- `path === ""` を worktree 自体を指す値として扱う（Swift `relDir` SSOT と整合）。`isRootPath()` で 1 か所判定
- ボタン非表示、初期 `expanded = true`、`onMounted` で `loadChildren()` を起動
- 表示要素由来の computed（`textColorClass` / `effectiveGitChange` / `iconUrl`）はテンプレートが `<button v-if="!isRoot">` でガードしているため、root では lazy 評価により実行されない。ルート専用の早期 return は持たない（v-if を唯一の防壁とする）
- `depth` の意味は「自身のインデント階層」。root には FilerPane が sentinel `-1` を渡し、root 自身は描画されないので depth は使われない。子に渡す depth は通常通り `depth + 1` で、root 直下の子は `-1 + 1 = 0` から始まる

## レース対策

- `loadChildren` は per-instance 世代カウンタで保護。await 後に「自分が最新の呼び出し」でなければ
  結果を破棄する。同一 dir 内で `fsChange` / `gitStatusChange` / `snapshotHash 変化` が連発した時に
  古い RPC レスポンスが新しい entries を踏み潰すのを防ぐ

## 更新（イベント駆動）

- filer event store の fsChange を watch して自分の path 該当時に再読み込み (snapshot mode では skip)
- filer event store の gitStatusChange を watch して展開中なら children を再構築 (snapshot mode では skip)
- snapshotHash 変化を watch して展開中なら children を再 load (cache invalidate)
- worktreeStore.revealVersion を watch して selectedRelPath が自分または配下なら展開＋スクロール
- 親→子の命令呼び出し（defineExpose）は使わず、各ノードが自律的にイベントを処理する設計
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, onMounted, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import type { FileContextMenuPayload } from "../navigator";
import {
  resolveDirectoryGitChange,
  resolveFileGitChange,
  resolveGitChangeKind,
  useWorktreeStore,
} from "../worktree";
import type { GitChangeKind } from "../worktree";
import {
  getDeletedEntries,
  isDescendantOf,
  isRootPath,
  joinPath,
  pathForNativeRpc,
  sortEntries,
  toFileEntries,
  toFileEntriesFromGitTree,
} from "./filerUtils";
import type { FileEntry, FileEntryKind } from "./filerUtils";
import { rpcFsReadDir, rpcGitLsTree } from "./rpc";
import { getFileIconUrl, getFolderIconUrl } from "./useFileIcon";
import { useFilerEventStore } from "./useFilerEventStore";

const GIT_CHANGE_COLOR_MAP: Record<GitChangeKind, string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  untracked: "text-green-400",
  renamed: "text-blue-400",
};

const props = defineProps<{
  name: string;
  /** worktree からの相対パス。worktree 直下（不可視ルート）は `""` */
  path: string;
  kind: FileEntryKind;
  /** working tree モード由来の gitignore フラグ。snapshot mode では undefined */
  isIgnored?: boolean;
  /** ファイル自身の git 変更種別 */
  gitChange?: GitChangeKind;
  /** git status マップ全体（ディレクトリの変更種別推論に使用） */
  gitStatuses: Record<string, string>;
  /**
   * 自身のインデント階層。worktree 不可視ルートには FilerPane が sentinel `-1` を渡す
   * （root は描画されないので負値の paddingLeft は実体に到達しない）。
   * 子は通常通り `depth + 1` を受け取る。root 直下は `-1 + 1 = 0` から始まる。
   */
  depth: number;
  selectedRelPath?: string;
  /**
   * snapshot mode のとき、そのコミットの hash。working tree モードでは undefined。
   * 子に同じ値を継承する。
   */
  snapshotHash?: string;
}>();

const emit = defineEmits<{
  select: [path: string];
  /**
   * 右クリック時に親に bubble する。NavigatorPane が popover singleton を open する責務を持つ。
   * 子 FileTreeItem からの emit もここで素通しで bubble する (再帰的に root pane まで上がる)。
   * payload 型は navigator が SSOT として export (type-only import で依存方向は壊さない)。
   */
  contextMenu: [payload: FileContextMenuPayload];
}>();

const notify = useNotificationStore();
const worktreeStore = useWorktreeStore();
const filerEventStore = useFilerEventStore();

const isRoot = computed(() => isRootPath(props.path));
const isDirectory = computed(() => props.kind === "directory");
const isSnapshot = computed(() => props.snapshotHash !== undefined);
/**
 * click で何も起きない葉。`gitShowCommitFile` で内容を取得できない (submodule) / snapshot
 * 環境で意味のある内容を取れない (symlink in snapshot) ものを構造的に弾く。
 */
const isInertLeaf = computed(() => {
  if (props.kind === "submodule") return true;
  if (props.kind === "symlink" && isSnapshot.value) return true;
  return false;
});

const buttonRef = useTemplateRef<HTMLButtonElement>("button");
const expanded = ref(isRoot.value);
const children = ref<FileEntry[]>();
const loading = ref(false);

/**
 * loadChildren の呼び出し世代カウンタ。`fsChange` / `gitStatusChange` / snapshotHash 変化の
 * 連続発火で `rpcFsReadDir` / `rpcGitLsTree` レスポンス順序が逆転して古い entries が新しい
 * entries を踏み潰す race を防ぐ。
 */
let loadSeq = 0;

// 以下の表示要素由来 computed はテンプレートの `<button v-if="!isRoot">` 配下でしか参照されない。
// Vue の computed は lazy 評価のため、root では実体が走らない。早期 return ガードは持たない
// （v-if が唯一の防壁）。

/**
 * gitStatuses マップからリアルタイムに変更種別を算出する。
 * snapshot mode では概念上意味を持たないため undefined を返す (working tree の status を
 * 過去 tree に重ねると phantom badge になる)。
 */
const effectiveGitChange = computed<GitChangeKind | undefined>(() => {
  if (isSnapshot.value) return undefined;
  // 削除エントリ（打ち消し線）は親から渡された gitChange をそのまま使う
  if (props.gitChange === "deleted") return "deleted";
  if (isDirectory.value) {
    return resolveDirectoryGitChange(props.path, props.gitStatuses);
  }
  return resolveFileGitChange(props.path, props.gitStatuses);
});

const textColorClass = computed(() => {
  if (effectiveGitChange.value) return GIT_CHANGE_COLOR_MAP[effectiveGitChange.value];
  if (props.isIgnored === true) return "text-zinc-500";
  if (props.selectedRelPath === props.path) return "text-white";
  return "text-zinc-300";
});

/** 削除ファイルかどうか (snapshot mode では発生しない) */
const isDeleted = computed(() => !isSnapshot.value && props.gitChange === "deleted");

/** material-icon-theme のアイコン URL */
const iconUrl = computed(() => {
  if (isDirectory.value) {
    return getFolderIconUrl(props.name, expanded.value);
  }
  return getFileIconUrl(props.name);
});

async function toggle() {
  if (isDirectory.value) {
    expanded.value = !expanded.value;
    // 初回展開時のみ読み込む
    if (expanded.value && children.value === undefined) {
      await loadChildren();
    }
    return;
  }
  // gitShowCommitFile 等で内容を取れない葉は preview にも流さない
  if (isInertLeaf.value) return;
  emit("select", props.path);
}

async function loadChildren() {
  const mySeq = ++loadSeq;
  loading.value = true;
  const dir = worktreeStore.dir;
  if (dir === undefined) {
    if (mySeq === loadSeq) {
      children.value = [];
      loading.value = false;
    }
    return;
  }

  // snapshot mode: git ls-tree でそのコミット時点の 1 階層を取得する。
  // working tree モードの fs RPC とは経路が完全に分かれ、git status マージや
  // 削除仮想エントリの合成は行わない (snapshot tree は git status と無関係)。
  if (props.snapshotHash !== undefined) {
    const result = await tryCatch(
      rpcGitLsTree({
        dir,
        hash: props.snapshotHash,
        path: isRoot.value ? "" : props.path,
      }),
    );
    if (mySeq !== loadSeq) return;
    if (!result.ok) {
      const label = isRoot.value ? "(worktree root)" : props.path;
      notify.error(`Failed to read snapshot tree: ${label}`, result.error);
      children.value = [];
      loading.value = false;
      return;
    }
    children.value = sortEntries(toFileEntriesFromGitTree(result.value.entries));
    loading.value = false;
    return;
  }

  const result = await tryCatch(rpcFsReadDir({ dir, path: pathForNativeRpc(props.path) }));
  // await 中に loadChildren が再度呼ばれた場合、この呼び出しの結果は破棄する
  if (mySeq !== loadSeq) return;
  if (!result.ok) {
    // 削除ディレクトリの場合、readDir は失敗するので削除エントリのみ表示
    const deletedEntries = getDeletedEntries(props.path, props.gitStatuses);
    if (deletedEntries.length > 0) {
      children.value = sortEntries(deletedEntries);
    } else {
      const label = isRoot.value ? "(worktree root)" : props.path;
      notify.error(`Failed to read directory: ${label}`, result.error);
      children.value = [];
    }
    loading.value = false;
    return;
  }
  children.value = mergeWithGitStatus(toFileEntries(result.value.entries));
  loading.value = false;
}

/** readDir の結果に git 変更情報と削除ファイルをマージする */
function mergeWithGitStatus(entries: FileEntry[]): FileEntry[] {
  const existingNames = new Set(entries.map((e) => e.name));

  const withGitChange = entries.map((entry): FileEntry => {
    const filePath = joinPath(props.path, entry.name);
    const statusCode = props.gitStatuses[filePath];
    if (statusCode) {
      return { ...entry, gitChange: resolveGitChangeKind(statusCode) };
    }
    return entry;
  });

  const deletedEntries = getDeletedEntries(props.path, props.gitStatuses).filter(
    (e) => !existingNames.has(e.name),
  );

  return sortEntries([...withGitChange, ...deletedEntries]);
}

// ルートノードは worktree 自体を表すため、マウント時点で子（ルート直下のエントリ）を読み込む。
// 通常ノードは初回展開時に loadChildren が走るが、ルートは常時 expanded なので初期 mount にフックする。
onMounted(() => {
  if (isRoot.value) void loadChildren();
});

// fsChange を購読し、自分の path が変更対象なら再読み込み（折りたたみ中はキャッシュ破棄）。
// 自分の path 配下のノードは独立に同じ store を watch しているため、再帰伝播は不要。
// ルートノード（path === ""）は worktree 直下の fsChange（relDir === ""）にマッチする。
// snapshot mode は不変な git object を表示しているので fs 変化を無視する。
watch(
  () => filerEventStore.fsChangeEvent,
  (event) => {
    if (event === undefined) return;
    if (isSnapshot.value) return;
    if (!isDirectory.value) return;
    if (event.relDir !== props.path) return;
    if (expanded.value) {
      void loadChildren();
    } else {
      // 折りたたみ中なら次回展開時に再読み込みするためキャッシュを破棄
      children.value = undefined;
    }
  },
);

// gitStatusChange を購読し、展開中の children を再構築する（削除仮想エントリの追加/除去）。
// computed の再計算だけでは entries の追加削除を反映できないため、明示的に再読み込みする。
// snapshot mode では working tree の git status を tree に重ねないため購読しない。
watch(
  () => filerEventStore.gitStatusChangeVersion,
  () => {
    if (isSnapshot.value) return;
    if (!isDirectory.value) return;
    if (expanded.value && children.value !== undefined) {
      void loadChildren();
    } else {
      // 折りたたみ中なら次回展開時に再読み込みするためキャッシュを破棄
      children.value = undefined;
    }
  },
);

// snapshotHash の変化 (mode 切替 / 別 commit への切替) で children cache を invalidate して
// 再 load する。展開状態 (expanded) と孫ノードの instance はそのまま保持されるため、
// 同じ dir で working ↔ snapshot を行き来しても展開してきた構造が消えない。
// loadSeq により旧 mode の in-flight RPC は破棄される。
watch(
  () => props.snapshotHash,
  () => {
    if (!isDirectory.value) return;
    if (expanded.value) {
      void loadChildren();
    } else {
      children.value = undefined;
    }
  },
);

/**
 * revealVersion 変化で worktreeStore.selectedRelPath を見て、自分が target または target の祖先なら処理。
 * 祖先の場合は展開するだけ。子は v-for でマウント後に自分の revealVersion watch (immediate)
 * で target を処理する再帰チェーン。
 *
 * ルートノード（path === ""）は `isDescendantOf` で worktree 内の任意 target の祖先扱い。
 *
 * absolute 選択中 (worktree 外) は selectedRelPath が undefined になり reveal は no-op。
 * ツリーが持っていないパスをマッチさせる経路を型レベルで排除する。
 */
async function handleReveal() {
  const targetPath = worktreeStore.selectedRelPath;
  if (targetPath === undefined) return;
  // 自身がターゲットの場合、展開してスクロールインビュー
  if (targetPath === props.path) {
    if (isDirectory.value && !expanded.value) {
      expanded.value = true;
      if (children.value === undefined) {
        await loadChildren();
      }
    }
    buttonRef.value?.scrollIntoView({ block: "nearest" });
    return;
  }
  // ディレクトリでないか、ターゲットが自身の配下でない場合は何もしない
  if (!isDirectory.value) return;
  if (!isDescendantOf(targetPath, props.path)) return;
  // 自身の配下に target がある場合、自分は展開するだけ（target そのものへの scroll は
  // 子の watch が処理する）。子は v-for で children を読み込むとマウントされ、
  // immediate watch が現在の revealVersion で発火する
  if (!expanded.value) {
    expanded.value = true;
    if (children.value === undefined) {
      await loadChildren();
    }
  }
}

watch(
  () => worktreeStore.revealVersion,
  () => {
    void handleReveal();
  },
  { immediate: true },
);

function onChildSelect(childPath: string) {
  emit("select", childPath);
}

/**
 * 右クリック。file leaf でかつ非 inert のときだけ menu を開く。
 *
 * - directory: 早期 return (folder は menu アクション無し、OS 標準右クリック menu に倒す)。
 *   Changes 側 (folder で no-op) との対称性を取る
 * - inert leaf (submodule / snapshot symlink): 早期 return (working tree に同名 file がある
 *   絶対パスを誤って copy 可能にする UI を構造的に排除する)
 * - 上記以外: preventDefault + emit で navigator まで bubble する
 *
 * commitHash は navigator が `useGitGraphStore.contextMenuHash` で SSOT 解決するため payload
 * には乗せない (filer の `snapshotHash` は filer ツリー表示用なので copy 経路と分離する)。
 *
 * 同サイクル open による light-dismiss 回避 / showPopover の defer は NavigatorPane が
 * 処理する責務。本 component は payload を作って emit するだけ。
 */
function onContextMenu(event: MouseEvent) {
  if (isDirectory.value) return;
  if (isInertLeaf.value) return;
  if (!(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  emit("contextMenu", {
    anchorEl: event.currentTarget,
    relPath: props.path,
    x: event.clientX,
    y: event.clientY,
  });
}
</script>

<template>
  <div>
    <button
      v-if="!isRoot"
      ref="button"
      class="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-sm select-none hover:bg-zinc-700"
      :class="[
        selectedRelPath === path ? 'bg-zinc-700' : '',
        textColorClass,
        isDeleted ? 'line-through opacity-60' : '',
        isInertLeaf ? 'cursor-not-allowed opacity-60' : '',
      ]"
      :style="{ paddingLeft: `${depth * 16 + 4}px` }"
      :title="kind === 'submodule' ? 'submodule (not previewable)' : undefined"
      @click="toggle"
      @contextmenu="onContextMenu"
    >
      <!-- ディレクトリの展開/折りたたみアイコン -->
      <span
        v-if="isDirectory"
        class="size-4 shrink-0"
        :class="expanded ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'"
      />
      <!-- ファイル用のスペーサー -->
      <span v-else class="size-4 shrink-0" />

      <img
        :src="iconUrl"
        class="size-4 shrink-0"
        :class="isIgnored === true ? 'opacity-50' : ''"
        alt=""
      />
      <span class="truncate">{{ name }}</span>
    </button>

    <!-- 子エントリ -->
    <template v-if="isDirectory && expanded">
      <div
        v-if="loading && !children"
        class="py-1 text-xs text-zinc-500"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 4}px` }"
      >
        Loading...
      </div>
      <FileTreeItem
        v-for="child in children"
        :key="`${child.name}-${child.kind}`"
        :name="child.name"
        :path="joinPath(path, child.name)"
        :kind="child.kind"
        :is-ignored="child.isIgnored"
        :git-change="child.gitChange"
        :git-statuses="gitStatuses"
        :snapshot-hash="snapshotHash"
        :depth="depth + 1"
        :selected-rel-path="selectedRelPath"
        @select="onChildSelect"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </template>
  </div>
</template>
