<doc lang="md">
ファイルツリーの再帰的なノード。

## 動作

- `kind === "directory"` は展開/折りたたみ可能で、初回展開時に RPC で子エントリを遅延読み込み
- material-icon-theme のアイコンを表示
- git status に応じた色分け（modified=黄、added=緑、deleted=赤、renamed=青）と削除ファイルの打ち消し線

## click 経路（kind ごとの差）

- `directory`: 展開 / 折りたたみ
- `file`: `select` emit
- `symlink`: 実体を持たない symlink のみこの kind に来る（working tree の dangling / 循環、
  snapshot tree の symlink blob）。working tree では `select` emit（preview が not found を出す）、
  snapshot mode では blob 内容が target path 文字列でしかないため click を no-op に倒す
- `submodule`: 常に no-op。gitlink object (`160000`) は `gitShowCommitFile` で内容を取得できないため
  preview に流すとエラーになる。視覚的にも opacity を落として「click できない」ことを示す

## symlink

表示 2 軸（バッジ / 名前の色）と色の優先順位、右クリック項目の切り分けは
[docs/filer.md](../../../../../docs/filer.md#symlink-の表示) が SSOT。本 component 固有の点だけ:

- バッジは行の hover / 選択色に追従せず自前の面を持つ。実体の種別でアイコン自体が決まる
  （dir symlink はフォルダアイコン）ため、link であることは重ね表示でしか表現できず、背景に
  溶けると矢印が読めない
- 右クリック payload には事実として `realTarget` をそのまま載せ、どの項目を出せるかの判定は
  menu 側 (FileContextMenu) が持つ。項目を足すたびに払い出し側を触らないための責務分割

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

- `path === ""` を worktree 自体を指す値として扱う（main 側 `relDir` SSOT と整合）。`isRootPath()` で 1 か所判定
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
- worktreeStore.revealRequest を watch して対象パスが自分または配下なら展開＋スクロール。要求元は
  selection 由来 (select\*Path) と選択を動かさない tree reveal (revealRelPath) の 2 経路
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
import type { FileEntry, FileEntryKind, FileRealTarget } from "./filerUtils";
import { rpcFsReadDir, rpcGitLsTree } from "./rpc";
import { getFileIconUrl, getFolderIconUrl } from "./useFileIcon";
import { useFilerEventStore } from "./useFilerEventStore";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideChevronRight from "~icons/lucide/chevron-right";
import IconLucideCornerUpRight from "~icons/lucide/corner-up-right";

const GIT_CHANGE_COLOR_MAP: Record<GitChangeKind, string> = {
  modified: "text-warning-text",
  added: "text-success-text",
  deleted: "text-destructive-text",
  untracked: "text-success-text",
  renamed: "text-primary-text",
};

const props = defineProps<{
  name: string;
  /** worktree からの相対パス。worktree 直下（不可視ルート）は `""` */
  path: string;
  /** 実体としての種別。working tree の symlink は解決済みの実体側 kind が届く */
  kind: FileEntryKind;
  /** symlink 経由の entry か（kind とは独立。link バッジの表示 SSOT） */
  isSymlink?: boolean;
  /** 実体の在り処。右クリック menu の実体向け項目の対象 */
  realTarget?: FileRealTarget;
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
   * 右クリック menu が open 中の操作対象 relPath。menu が閉じると undefined に戻る。
   * 選択 (selectedRelPath) とは独立の一時状態で、menu の操作対象がどの行かを outline で
   * 可視化する (右クリックで選択を動かすと preview 連動の副作用が出るため選択は変えない)。
   */
  menuTargetRelPath?: string;
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

/**
 * 実体がツリー上のパスと別の場所にある行。名前の色はこの軸で付ける: 右クリックで実体向け項目が出る
 * 集合と一致するため「色が付いている = 実体へのアクションがある」が一貫して読める（link 配下も色が
 * 続く）。実体を持たない dangling / 循環はバッジと tooltip (broken symlink) だけで表し色は付けない。
 */
const isLinked = computed(() => props.realTarget !== undefined);

// 優先順位は git change > link > ignored。link 色を ignored の下に置くと、gitignore 対象が
// 大半を占める実運用 (worktree symlink 等) でほぼ発火しないため ignored より上に置く。
// git change は「今この行に起きている変化」で link より緊急度が高く、色を譲っても
// link であることはバッジが示し続ける。
const textColorClass = computed(() => {
  if (effectiveGitChange.value) return GIT_CHANGE_COLOR_MAP[effectiveGitChange.value];
  if (isLinked.value) return "text-info";
  if (props.isIgnored === true) return "text-foreground-low";
  if (props.selectedRelPath === props.path) return "text-foreground";
  return "text-foreground";
});

// snapshot mode では面自体が element と同値 (background-readonly = gray step 3) に上がるため、
// hover / 選択を element のままにすると同色で識別が消える。1 段明るい element-hover に逃がす
const rowHoverClass = computed(() =>
  isSnapshot.value ? "hover:bg-element-hover" : "hover:bg-element",
);
const rowSelectedClass = computed(() => (isSnapshot.value ? "bg-element-hover" : "bg-element"));

/** 削除ファイルかどうか (snapshot mode では発生しない) */
const isDeleted = computed(() => !isSnapshot.value && props.gitChange === "deleted");

/**
 * hover tooltip。symlink バッジは「link であること」しか伝えられないため、実体を解決できない
 * ケース (kind === "symlink") だけ文言で区別する。working tree では dangling / 循環、
 * snapshot tree では blob が target path 文字列でしかないことを指す。
 */
const rowTitle = computed(() => {
  if (props.kind === "submodule") return "submodule (not previewable)";
  if (props.kind === "symlink") return isSnapshot.value ? "symlink" : "broken symlink";
  if (props.isSymlink === true) return "symlink";
  return undefined;
});

/** material-icon-theme のアイコン URL */
const iconUrl = computed(() => {
  if (isDirectory.value) {
    return getFolderIconUrl(props.name, expanded.value);
  }
  return getFileIconUrl(props.name);
});

async function toggle(event: MouseEvent) {
  // macOS の control+click は WebKit が button=0 + click event として dispatch する
  // (webkit bugzilla 52174)。contextmenu と一緒に通常 click も発火するため、control+click
  // は context menu trigger の意図として toggle / select には倒さず contextmenu 経路に委譲。
  // gozd は macOS 専用 (root CLAUDE.md) なので ctrlKey === control+click と等価。cross-platform
  // 対応する場合は OS 判定 (navigator.platform / userAgent) で macOS 経路に絞る必要がある。
  if (event.ctrlKey) return;
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
    // permission 等の真の読み取りエラー。ディレクトリ不在は native が notFound で返すため
    // ここには来ない（エラートーストは出さない経路と分離）。
    const label = isRoot.value ? "(worktree root)" : props.path;
    notify.error(`Failed to read directory: ${label}`, result.error);
    children.value = [];
    loading.value = false;
    return;
  }
  if (result.value.notFound) {
    // ディレクトリが削除された。git 追跡下の削除エントリがあれば打ち消し線で表示し、
    // untracked なら空にする。削除は期待挙動なのでエラートーストは出さない。
    children.value = sortEntries(getDeletedEntries(props.path, props.gitStatuses));
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
 * reveal 要求 (worktreeStore.revealRequest) の対象が自分または自分の配下なら処理する。
 * 祖先の場合は展開するだけ。子は v-for でマウント後に自分の revealRequest watch (immediate)
 * で target を処理する再帰チェーン。
 *
 * ルートノード（path === ""）は `isDescendantOf` で worktree 内の任意 target の祖先扱い。
 *
 * 要求元は selection 由来 (select*Path) と選択を動かさない tree reveal (revealRelPath) の
 * 2 経路で、どちらも request の relPath が対象。absolute 選択中 (worktree 外) は request が
 * undefined に落ち、ツリーが持っていないパスをマッチさせる経路を構造的に排除する。
 *
 * `loadChildren` の await を挟むため、`seq` で世代保護する (loadChildren 自身の `loadSeq` と同じ
 * 規律)。await 中に来た新しい要求が load 不要で先に完走すると、古い要求の scrollIntoView が
 * 後から上書きしてしまう。
 */
async function handleReveal() {
  const request = worktreeStore.revealRequest;
  const targetPath = request?.relPath;
  if (request === undefined || targetPath === undefined) return;
  const isLatestRequest = () => worktreeStore.revealRequest?.seq === request.seq;
  // 自身がターゲットの場合、展開してスクロールインビュー
  if (targetPath === props.path) {
    if (isDirectory.value && !expanded.value) {
      expanded.value = true;
      if (children.value === undefined) {
        await loadChildren();
      }
    }
    if (!isLatestRequest()) return;
    buttonRef.value?.scrollIntoView({ block: "nearest" });
    return;
  }
  // ディレクトリでないか、ターゲットが自身の配下でない場合は何もしない
  if (!isDirectory.value) return;
  if (!isDescendantOf(targetPath, props.path)) return;
  // 自身の配下に target がある場合、自分は展開するだけ（target そのものへの scroll は
  // 子の watch が処理する）。子は v-for で children を読み込むとマウントされ、
  // immediate watch が現在の revealRequest で発火する
  if (!expanded.value) {
    expanded.value = true;
    if (children.value === undefined) {
      await loadChildren();
    }
  }
}

watch(
  () => worktreeStore.revealRequest,
  () => {
    void handleReveal();
  },
  { immediate: true },
);

function onChildSelect(childPath: string) {
  emit("select", childPath);
}

/**
 * 右クリック。directory / file どちらも実体 path を持つ行は menu 対象にする。inert leaf のみ除外。
 *
 * - directory / file: menu 対象 (実 filesystem path として絶対 path を copy する)
 * - inert leaf (submodule / snapshot symlink): 早期 return (snapshot 時点と working tree の
 *   実体が一致しないため、working tree の絶対 path を誤って copy 可能にする UI を排除)
 *
 * commitHash は navigator が `useGitGraphStore.contextMenuHash` で SSOT 解決するため payload
 * には乗せない (filer の `snapshotHash` は filer ツリー表示用なので copy 経路と分離する)。
 *
 * light-dismiss 回避 (pointerup 待機) は NavigatorPane が処理する責務。本 component は
 * payload を作って emit するだけ。
 */
function onContextMenu(event: MouseEvent) {
  if (isInertLeaf.value) return;
  if (!(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  emit("contextMenu", {
    anchorEl: event.currentTarget,
    relPath: props.path,
    realTarget: props.realTarget,
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
      class="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-sm"
      :class="[
        rowHoverClass,
        selectedRelPath === path ? rowSelectedClass : '',
        menuTargetRelPath === path ? 'ring-1 ring-ring ring-inset' : '',
        textColorClass,
        isDeleted ? 'text-foreground-muted line-through' : '',
        isInertLeaf ? 'cursor-not-allowed text-foreground-muted' : '',
      ]"
      :style="{ paddingLeft: `${depth * 16 + 4}px` }"
      :title="rowTitle"
      @click="toggle"
      @contextmenu="onContextMenu"
    >
      <!-- ディレクトリの展開/折りたたみアイコン -->
      <component
        :is="expanded ? IconLucideChevronDown : IconLucideChevronRight"
        v-if="isDirectory"
        class="size-4 shrink-0"
      />
      <!-- ファイル用のスペーサー -->
      <span v-else class="size-4 shrink-0" />

      <span class="relative flex size-4 shrink-0">
        <img :src="iconUrl" class="size-4" :class="isIgnored === true ? 'grayscale' : ''" alt="" />
        <!-- symlink バッジ。実体の種別でアイコン自体が決まる（dir symlink はフォルダアイコン）
             ため、「実体への転送」は重ね表示でしか表現できない。Finder の alias バッジと同じく
             行の hover / 選択色には追従せず自前の面を持つ（背景に溶けると矢印が読めない） -->
        <IconLucideCornerUpRight
          v-if="isSymlink === true"
          class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-background text-info"
        />
      </span>
      <span class="truncate">{{ name }}</span>
    </button>

    <!-- 子エントリ -->
    <template v-if="isDirectory && expanded">
      <div
        v-if="loading && !children"
        class="py-1 text-xs text-foreground-low"
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
        :is-symlink="child.isSymlink"
        :real-target="child.realTarget"
        :is-ignored="child.isIgnored"
        :git-change="child.gitChange"
        :git-statuses="gitStatuses"
        :snapshot-hash="snapshotHash"
        :depth="depth + 1"
        :selected-rel-path="selectedRelPath"
        :menu-target-rel-path="menuTargetRelPath"
        @select="onChildSelect"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </template>
  </div>
</template>
