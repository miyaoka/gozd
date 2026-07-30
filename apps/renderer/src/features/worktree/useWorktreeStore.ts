import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { resolveFileGitChange } from "./gitStatusUtils";
import {
  normalizeAbsolute,
  normalizeRelative,
  pathTargetToString,
  type PathTarget,
} from "./pathUtils";
import { useGitStatusStore } from "./useGitStatusStore";

/**
 * プレビュー対象の selection。`PathTarget` に行番号 (terminal link / markdown anchor 由来) を
 * 追加した形。store 内部状態は本型で保持し、消費側は `kind` で switch する。
 */
export type Selection = PathTarget & { lineNumber?: number };

export const useWorktreeStore = defineStore("worktree", () => {
  const repoStore = useRepoStore();

  const selection = ref<Selection>();

  /**
   * `select*Path()` のたびに進むカウンタ。同一パスの再選択も観測できる signal で、preview が
   * 「選択し直された」ことを検出して行スクロールをやり直すために購読する。
   * **invariant**: bump は必ず `selection.value` の同期更新とセットで行う（= 必ず
   * `selectRelPath()` / `selectAbsPath()` 経由）。選択を動かさない tree reveal
   * （`revealRelPath()`）では bump しない。
   */
  const selectPathVersion = ref(0);

  /**
   * ツリー reveal（展開 + スクロール）の要求。**selection とは別概念**として持つ。
   * symlink の実体がディレクトリのとき「ツリーだけ実体へ移動する」経路が要り、そこで
   * selection を動かすと preview がディレクトリ表示（"Directory" プレースホルダ）に落ちる。
   *
   * 購読側（FileTreeItem）は本 ref だけを watch し、対象パスも request から読む（selection を
   * 別途読まないので「trigger と対象パスが同 tick で食い違う」経路が構造的に存在しない）。
   * 同一パスの再要求が発火するのは要求ごとに新しい object を立てるためで、`seq` は購読側が
   * await を挟んだ後に「自分が処理していた要求が最新か」を判定する世代番号（FileTreeItem の
   * `handleReveal` が消費する）。
   */
  const revealRequest = ref<{ relPath: string; seq: number }>();
  let revealSeq = 0;

  function requestReveal(relPath: string | undefined) {
    if (relPath === undefined) {
      revealRequest.value = undefined;
      return;
    }
    revealSeq++;
    revealRequest.value = { relPath: normalizeRelative(relPath), seq: revealSeq };
  }

  /** setOpen 呼び出しごとにインクリメント。観測側（terminal 等）が「wt 選択イベント」として購読する */
  const selectionVersion = ref(0);

  const gitStatusStore = useGitStatusStore();

  /** 現在 UI で選択中の dir。repoStore.selectedDir の薄いエイリアス */
  const dir = computed(() => repoStore.selectedDir);

  /**
   * worktree 内のパス（filer reveal / git 系 RPC が扱える）。
   * 絶対パス選択中は undefined を返す。
   */
  const selectedRelPath = computed(() =>
    selection.value?.kind === "worktreeRelative" ? selection.value.relPath : undefined,
  );

  /**
   * 表示用パス文字列（ヘッダのタイトル / breadcrumb 等）。worktreeRelative なら relPath、
   * absolute なら absPath を返す。RPC 呼び出しや git 操作の入力には使わない。
   */
  const selectedDisplayPath = computed(() => {
    const sel = selection.value;
    return sel === undefined ? undefined : pathTargetToString(sel);
  });

  /** リンクから指定された行番号（1-based）。スクロール・ハイライトに使用 */
  const selectedLineNumber = computed(() => selection.value?.lineNumber);

  /**
   * git status から都度算出するため、status 更新時に自動反映される。
   * absolute 選択中は worktree 外で git 履歴を持たないため undefined。
   */
  const selectedGitChange = computed(() => {
    const relPath = selectedRelPath.value;
    if (relPath === undefined) return undefined;
    return resolveFileGitChange(relPath, gitStatusStore.gitStatuses);
  });

  // dir が変わるたびに selection を即座に落とす。setOpen を経由しない経路
  // （repoStore.removeRepo 内の selectedDir 直書きなど）でも一貫してクリアされる。
  // flush: 'sync' により、setOpen が同期で続けて selectRelPath を書き込む際に
  // 「クリア → 新値書き込み」の順序が崩れない。
  watch(
    dir,
    () => {
      selection.value = undefined;
      revealRequest.value = undefined;
    },
    { flush: "sync" },
  );

  /**
   * worktree 切替（同 repo 内）専用。新 dir は既に repoStore に登録済みであることが前提。
   * 新規 repo の追加は App.vue の gozdOpen ハンドラが行う。
   *
   * **scope**: dir 切替のみ。「ファイル選択 + preview を開く」副作用は呼び出し側が
   * `usePreviewStore.forceSelect` / `requestSelect` を明示的に呼ぶ契約に集約してある
   * （[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）。setOpen 自体には
   * preview の開閉責務を持たせない。
   */
  function setOpen(newDir: string) {
    repoStore.selectDir(newDir);
    selectionVersion.value++;
  }

  function selectRelPath(relPath: string, lineNumber?: number) {
    if (!dir.value) return;
    selection.value = {
      kind: "worktreeRelative",
      relPath: normalizeRelative(relPath),
      lineNumber,
    };
    requestReveal(relPath);
    selectPathVersion.value++;
  }

  /**
   * selection を動かさずにツリーだけ対象パスへ reveal する。symlink の実体（ディレクトリ）へ
   * 移動する経路で使う。preview は selection を SSOT にしているため、開いているファイルの
   * 表示は保たれる。
   */
  function revealRelPath(relPath: string) {
    if (!dir.value) return;
    requestReveal(relPath);
  }

  // absolute は dir 文脈を必要としない (読みは fsReadFileAbsolute 単独、filer reveal は
  // relPath 不在で no-op) ため、relPath と違い dir 未確立でも選択を成立させる。
  // repo 未選択のまま session log 等の worktree 外ファイルを preview する経路が該当する。
  function selectAbsPath(absPath: string, lineNumber?: number) {
    selection.value = {
      kind: "absolute",
      absPath: normalizeAbsolute(absPath),
      lineNumber,
    };
    // worktree 外の選択はツリーに対応するノードが無いので reveal 要求を落とす
    requestReveal(undefined);
    selectPathVersion.value++;
  }

  /**
   * `PathTarget` を受けて kind に応じた select* に振り分ける。terminal link / markdown link
   * のように source 側で kind を分けて持っている経路で使う。kind 別 switch を呼び出し側に
   * 書かないことで「新規購読側で振り分け忘れる」経路を消す SSOT。
   */
  function selectFromTarget(target: PathTarget, lineNumber?: number) {
    if (target.kind === "worktreeRelative") {
      selectRelPath(target.relPath, lineNumber);
    } else {
      selectAbsPath(target.absPath, lineNumber);
    }
  }

  // reveal 要求も落とす。selection が無いのに要求だけ残ると、後から mount された FileTreeItem が
  // immediate watch で stale な path を掘り出し、消えたパスに向けてツリーが自動展開される
  function clearSelectedPath() {
    selection.value = undefined;
    requestReveal(undefined);
  }

  return {
    dir,
    selection,
    selectedRelPath,
    selectedDisplayPath,
    selectedLineNumber,
    selectedGitChange,
    selectPathVersion,
    revealRequest,
    selectionVersion,
    setOpen,
    selectRelPath,
    revealRelPath,
    selectAbsPath,
    selectFromTarget,
    clearSelectedPath,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorktreeStore, import.meta.hot));
}
