import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { useChangesSummaryStore } from "../changes";
import {
  normalizePathTarget,
  pathTargetEquals,
  type PathTarget,
  useWorktreeStore,
} from "../worktree";

/**
 * Preview popover の開閉と「選択 → 表示」の意思決定を集約する SSOT。
 *
 * `isOpen` は popover DOM の状態ではなく自前 ref で持ち、`open()` / `close()` の冪等 gate も
 * この ref だけで判定する。popover の可視状態遷移 (`:popover-open`) 自体は show/hide 呼び出しと
 * 同期で、task に queue される非同期発火は `toggle` event のみ (WHATWG HTML spec)。DOM state を
 * 判定材料にしないのは同期性の問題ではなく、開閉の意思決定 SSOT を store 1 つに保ち
 * 「store と DOM のどちらが正か」の分岐を作らないため (useServerStore と同じ契約)。
 *
 * ## 公開 API の意味契約（intent 別 entry point）
 *
 * 「ファイル選択 → preview を開く / 閉じる」の意思決定はこの store に集約する。
 * 入口ごとに `requestSelect` / `forceSelect` を使い分けることで、新規 entry point
 * 追加時に「同一パス再選択でトグルすべきか / 常に開くべきか」の判断漏れが構造的に
 * 発生しないようにする（[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）。
 *
 * - `requestSelect(target)`: user-initiated select（filer / changes / terminal link）。
 *   現在 selection と同一 path かつ preview 開なら close（summary 表示中は summary を抜ける）。
 *   それ以外は selection を切り替えて preview を開く
 * - `forceSelect(target)`: 強制 open（gozdOpen / markdown link navigation）。同一 path でも
 *   閉じない。「ユーザーが見たいファイルを CLI で明示指定した」「md 内 link で遷移した」など、
 *   navigation 意味の経路で使う
 * - `open()` / `close()` / `toggle()`: state の直接操作。ESC / button / `preview.toggle` コマンド
 *   などで使う。`close()` は「popover 閉 ⇒ summary 解除」の invariant を担う (close 経路は
 *   ESC / Preview ヘッダ close ボタン / dir 切替 / closeSummary すべて同一意味)
 * - `closeForMissingSelection()`: 表示中ファイルが実体としてどこにも存在しなくなった
 *   (未追跡ファイルの削除等) ときに選択解除して close する。current / HEAD いずれにも無いと
 *   content 取得層 (`usePreviewContent`) が判定した経路から呼ぶ
 * - `openSummary()` / `toggleSummary()`: summary 表示モードを open する意図単位 API。`close()` 側に
 *   invariant を寄せたので summary を閉じる専用 API は持たない (close と区別する意味が無い)
 *
 * ## 依存方向
 *
 * 本 store は `useWorktreeStore` / `useChangesSummaryStore` を保持する（preview が両者を
 * 消費する向き）。逆方向（worktree → preview, summary → preview）を作ると pinia の lazy
 * setup で循環解決が走り silent に壊れる経路ができるため、preview を中央集約点として
 * 他 store からは参照しない契約とする。
 */
export const usePreviewStore = defineStore("preview", () => {
  // **登録順依存**: `useWorktreeStore` の setup を本 store より前に走らせるため、必ず本 store
  // setup の冒頭で呼ぶ。`useWorktreeStore` は dir 変化に対する flush:'sync' watch (selection
  // clear) を内部に持ち、本 store の dir watch (close) より **先に** 発火する必要がある。
  // Vue 3 の sync watch は登録順に発火するため、`pinia.defineStore` の lazy setup でこれを
  // 先に initialize させることで順序を構造的に固定する。
  // `useChangesSummaryStore` は dir watch を持たない (dir 切替時の summary disable は本 store
  // の dir watch → close() invariant が担う)。
  const worktreeStore = useWorktreeStore();
  const summaryStore = useChangesSummaryStore();

  const popoverEl = ref<HTMLElement>();
  const isOpen = ref(false);

  function bindPopover(el: HTMLElement | undefined) {
    popoverEl.value = el;
  }

  function open() {
    if (isOpen.value) return;
    const el = popoverEl.value;
    if (!el) return;
    el.showPopover();
    isOpen.value = true;
  }

  function close() {
    // invariant: popover が閉じている間は summary も常に off。ESC / Preview ヘッダ close
    // ボタン / dir 切替経由でも適用される。これをやらないと summary enabled=true + popover
    // closed の状態が残り、次に preview を toggle で開いた瞬間に summary view が復活する。
    summaryStore.disable();
    if (!isOpen.value) return;
    const el = popoverEl.value;
    if (!el) return;
    el.hidePopover();
    isOpen.value = false;
  }

  function toggle() {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  // summary 表示モードを open する意図単位 API。close 方向は close() の invariant が担うため
  // 専用 API を分けない。`summaryStore.disable()` は requestSelect / ファイル選択経路で
  // 単独で使う (summary を抜けて単一ファイル表示にフォールバック、popover は維持) ため
  // summary store 側の API として残る。

  function openSummary() {
    summaryStore.enable();
    open();
  }

  function toggleSummary() {
    if (summaryStore.enabled) {
      close();
    } else {
      openSummary();
    }
  }

  /**
   * 現在 selection と target の同一性判定。両者を正規化してから比較する。
   * 入力 target は terminal の regex match 結果のように未正規化のことがあるため、
   * `selection` (selectRelPath / selectAbsPath で正規化済) と公平に比較するには
   * 入力側も正規化する必要がある。
   */
  function isSameAsCurrent(target: PathTarget): boolean {
    const sel = worktreeStore.selection;
    if (sel === undefined) return false;
    return pathTargetEquals(sel, normalizePathTarget(target));
  }

  /**
   * user-initiated select（navigator / terminal link 等）。
   *
   * 3 分岐:
   * - 同 path + 開 + summary 非表示 → close（トグル close）
   * - 同 path + 開 + summary 表示中 → summary を抜けて単一 file 表示へ（preview は閉じない）
   * - それ以外 → selection を切り替えて preview を開く
   *
   * dir 未確立 (`worktreeStore.dir` が undefined) のときは何もしない。selectFromTarget も
   * 内部で同じ条件で no-op するため、ここで早期 return しないと「selection 空のまま popover
   * だけ開く」状態が観察される。
   */
  function requestSelect(target: PathTarget, lineNumber?: number) {
    if (!worktreeStore.dir) return;
    if (isSameAsCurrent(target) && isOpen.value) {
      if (summaryStore.enabled) {
        summaryStore.disable();
        return;
      }
      close();
      return;
    }
    worktreeStore.selectFromTarget(target, lineNumber);
    open();
  }

  /**
   * 強制 open select（gozdOpen / markdown link 等のナビゲーション経路）。
   * 同一 path への再呼び出しでも閉じない。「always open」契約。
   *
   * `requestSelect` と同じく dir 未確立時は no-op（空 popover を作らない契約）。
   */
  function forceSelect(target: PathTarget, lineNumber?: number) {
    if (!worktreeStore.dir) return;
    worktreeStore.selectFromTarget(target, lineNumber);
    open();
  }

  /**
   * 表示中ファイルが実体としてどこにも存在しなくなった (未追跡ファイルの削除等) ときに、
   * 選択を解除して preview を閉じる。
   *
   * 「current (作業ツリー) にも HEAD にも無い」= 復元・閲覧できる内容が一切無い、の判定は
   * `usePreviewContent` が `fetchContent` の結果で行う (git status の push タイミングに依存せず
   * 両ソースを直接読んで確定する)。git 追跡下の削除は HEAD に内容が残り Original を閲覧できるため、
   * content 取得層はこの呼び出しに到達しない。
   *
   * `close()` の invariant (popover 閉 ⇒ summary 解除) に乗せるため close() を経由する。
   */
  function closeForMissingSelection() {
    worktreeStore.clearSelectedPath();
    close();
  }

  // dir 切替で preview を auto-close。新 worktree でファイル選択を伴う gozdOpen 経路では、
  // useGozdOpenHandler が dir 切替後に forceSelect を明示的に呼ぶため最終状態は新ファイル
  // で表示継続になる。
  //
  // flush: 'sync' 必須: gozdOpen handler が `setOpen → forceSelect` を同一 tick で連続呼び
  // するため、デフォルト `flush: 'pre'` だと close が forceSelect.open() の後に発火して
  // preview が閉じる順序バグになる。dir 変化と同期で close を消化させ、続く forceSelect の
  // open を最終状態として残す。
  watch(
    () => worktreeStore.dir,
    () => {
      close();
    },
    { flush: "sync" },
  );

  return {
    isOpen,
    bindPopover,
    open,
    close,
    toggle,
    openSummary,
    toggleSummary,
    requestSelect,
    forceSelect,
    closeForMissingSelection,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePreviewStore, import.meta.hot));
}
