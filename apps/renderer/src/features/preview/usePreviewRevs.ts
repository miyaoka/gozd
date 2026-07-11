/**
 * blame / file history の「どの rev を起点にするか」の導出層。表示中タブ (activeMode) と
 * commit / PR diff / uncommitted のモード文脈から rev を決め、line-no クリック → popover 起動の
 * 橋渡しと、文脈乖離時の popover 一括 close を担う。
 *
 * rev 決定ルールの決定表は docs/preview.md の BlamePopover / FileCommitDate セクションを参照。
 */
import { computed, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useChangesSummaryStore } from "../changes";
import { usePrDiffToggleStore } from "../git-graph";
import { UNCOMMITTED_HASH, useGitStatusStore, useWorktreeStore } from "../worktree";
import { revModeLabel, useBlamePopover, useFileHistoryPopover } from "./features/commit-history";
import type { PreviewContent } from "./usePreviewContent";
import { usePreviewEditStore } from "./usePreviewEditStore";

export function usePreviewRevs(content: PreviewContent) {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  const gitStatusStore = useGitStatusStore();
  const prDiffToggle = usePrDiffToggleStore();
  const summaryStore = useChangesSummaryStore();
  const editStore = usePreviewEditStore();
  const blamePopover = useBlamePopover();
  const fileHistoryPopover = useFileHistoryPopover();

  const { activeMode, orderedRange, isCommitMode, effectiveGitChange, isDirectory, contentEpoch } =
    content;

  /**
   * Current 側 (newer / working tree) を blame する際の rev。
   * - PR diff モード: "" = working tree
   * - uncommitted モード: "" = working tree
   * - commit モード: newer hash (Working Tree なら "")
   * orderedRange が null (不整合) なら undefined を返し、blame button は描画自体抑止する。
   */
  const currentRev = computed<string | undefined>(() => {
    if (prDiffToggle.isOn) return "";
    if (!isCommitMode.value) return "";
    const range = orderedRange.value;
    if (range === null) return undefined;
    return range.newer === UNCOMMITTED_HASH ? "" : range.newer;
  });

  /**
   * Original 側 (older^) を blame する際の rev。
   * - PR diff モード: `lockedBaseOid` (= `merge-base(HEAD, baseRefOid)`) を起点に blame する。
   *   ただし PR で追加されたファイル (effectiveGitChange === "added") は merge-base に存在しないため
   *   undefined を返し、blame button 経路で silent dead button にならないよう `blameEnabled` 側で
   *   構造的に抑止する。
   * - uncommitted モード: "HEAD"
   * - commit モード: `<older>^`。range.older は orderedRange が null でない限り
   *   必ず string で来る (型保証)。fetchCommitContent の fromHash と一致。
   */
  const originalRev = computed<string | undefined>(() => {
    if (prDiffToggle.isOn) {
      if (effectiveGitChange.value === "added") return undefined;
      return prDiffToggle.lockedBaseOid;
    }
    if (!isCommitMode.value) return "HEAD";
    const range = orderedRange.value;
    if (range === null) return undefined;
    if (range.older === undefined) {
      // 単一 commit 選択 (compareHash === null)。fetchCommitContent と同じく `<newer>^`
      return `${range.newer}^`;
    }
    return `${range.older}^`;
  });

  /** blame 不可なファイル (非 git project / 絶対パスの外部 open / PR diff の added file) を弾く判定。
   *  button 描画自体を gate して silent dead button (DiffPreview docstring 規約) を作らない。
   *
   *  - 非 git project は blame が `not a git repository` (exit 128) になるため全面抑止
   *  - worktreeRelative 以外 (absolute path) は git 履歴なしで blame 不成立
   *  - PR diff で added file は old 側 blame が `git blame <baseOid> -- <path>` で path 不在エラーに
   *    なるため、両側まとめて抑止する (現状の DiffPreview 単一 prop の API 制約上、side ごとに
   *    gate できないため最小コスト解。新側 blame も失うが、added file の PR view では trade-off で許容)
   */
  const blameEnabled = computed(() => {
    if (!repoStore.selectedIsGitRepo) return false;
    if (worktreeStore.selection?.kind !== "worktreeRelative") return false;
    if (prDiffToggle.isOn && effectiveGitChange.value === "added") return false;
    return true;
  });

  /**
   * ヘッダのコミット日表示 / ファイル history の起点 rev。
   * 表示中タブに追従する: Original タブは original 側 rev、Current / Diff は current 側 rev
   * (onCodeLineClick の rev 切替と同じ規律)。orderedRange null で undefined のときは
   * `fileHistoryEnabled` 側で表示を抑止する。
   */
  const historyRev = computed<string | undefined>(() =>
    activeMode.value === "original" ? originalRev.value : currentRev.value,
  );

  /**
   * ヘッダのコミット日を出すか。git repo かつ worktreeRelative かつ rev 解決済み、かつ
   * ディレクトリ選択でないときのみ。非 git project / 絶対パス (worktree 外 open) /
   * orderedRange 不整合 / ディレクトリを除外し、silent dead button や "ファイル単位" 機能の
   * ディレクトリ露出を防ぐ (`blameEnabled` が content 領域描画でディレクトリに出ないのと
   * 挙動を揃える)。非 git project を弾かないと file preview のたびに `git log` が exit 128 で
   * error toast になる。
   */
  const fileHistoryEnabled = computed(
    () =>
      repoStore.selectedIsGitRepo &&
      worktreeStore.selection?.kind === "worktreeRelative" &&
      historyRev.value !== undefined &&
      !isDirectory.value,
  );

  /**
   * FileCommitDate に渡す props 束。`enabled=false` のとき component は描画も fetch もしないため、
   * dir / relPath / rev の "" fallback は使われない (template を単純参照に保つための束ね)。
   */
  const fileCommitDateProps = computed(() => ({
    dir: worktreeStore.dir ?? "",
    relPath: worktreeStore.selectedRelPath ?? "",
    rev: historyRev.value ?? "",
    enabled: fileHistoryEnabled.value,
  }));

  function openBlame(rev: string, line: number, anchorEl: HTMLElement): void {
    const dir = worktreeStore.dir;
    const relPath = worktreeStore.selectedRelPath;
    // 絶対パス選択中 (worktree 外) は relPath が undefined になり blame を成立できない。
    // `blameEnabled` で button 描画自体を gate しているため通常は到達しないが、二重防御として early return。
    if (dir === undefined || relPath === undefined) return;
    // uncommitted モードの HEAD 側 blame は rename されたファイルだと新パスが HEAD に存在しない。
    // ChangesSummaryItem の side 別 path 選択と同じ規律で旧パスに揃える。
    const blamePath =
      rev === "HEAD" ? (gitStatusStore.renameOldPaths[relPath] ?? relPath) : relPath;
    blamePopover.open(anchorEl, {
      dir,
      relPath: blamePath,
      rev,
      line,
      modeLabel: revModeLabel(rev),
    });
  }

  function onCodeLineClick(payload: { line: number; anchorEl: HTMLElement }): void {
    // CodePreview は activeMode の content (current か original) をそのまま渡しているので
    // activeMode に応じて rev を切り替える。editable (常時編集) は Current タブでしか
    // 成立しない (usePreviewEdit の isEditable) ため、同じ分岐で currentRev に落ちる。
    const rev = activeMode.value === "original" ? originalRev.value : currentRev.value;
    if (rev === undefined) return;
    openBlame(rev, payload.line, payload.anchorEl);
  }

  function onDiffLineClick(payload: {
    side: "old" | "new";
    line: number;
    anchorEl: HTMLElement;
  }): void {
    const rev = payload.side === "old" ? originalRev.value : currentRev.value;
    if (rev === undefined) return;
    openBlame(rev, payload.line, payload.anchorEl);
  }

  /**
   * 表示中ファイル / commit selection / mode 切替で popover を必ず閉じる。
   * 文脈と blame popover が乖離した状態 (file B を選択しているのに popover は file A
   * の Line N を指す) を残さないための watcher。
   *
   * invariant「content が変わるなら必ず close」は `contentEpoch` (usePreviewContent の main watch
   * 発火ごとに増えるカウンタ) の購読で構造的に保証する。deps リストを content 側と二重管理して
   * 同期させる必要はない。
   */
  watch(
    [
      contentEpoch,
      activeMode,
      // summary view 切替で CodePreview / DiffPreview が unmount され anchor が detached
      // になるため、popover も同時に閉じる必要がある。
      () => summaryStore.enabled,
      // タイピングで行が増減すると popover の blame 行と表示行が乖離する。
      // blame は保存済み working tree に対して走る (CodePreview doc 参照) ため、draft の
      // 変更を検知したら popover を閉じて乖離状態を残さない。
      () => editStore.draftContent,
    ],
    () => {
      if (blamePopover.context.value !== undefined) {
        blamePopover.close();
      }
      if (fileHistoryPopover.context.value !== undefined) {
        fileHistoryPopover.close();
      }
    },
  );

  return {
    blameEnabled,
    fileCommitDateProps,
    onCodeLineClick,
    onDiffLineClick,
  };
}
