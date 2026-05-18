import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * filer 内部のイベント配信 store。
 *
 * 親 (FilerPane) → 子 (FileTreeItem) の命令的呼び出し（defineExpose / ref 経由）を避け、
 * 各 FileTreeItem が自律的にイベントを watch する設計に揃えるための bus。
 * - `fsChange` / `gitStatusChange` の push を受けた FilerPane が emit する
 * - 各 FileTreeItem が watch して自分の path に該当するか判定し、必要なら再読み込み
 *
 * `version` カウンタを併設しているのは、同一 `relDir` が連続発火しても watch を必ず
 * 発火させるため（オブジェクト reference の同一性で watch がスキップされるのを防ぐ）。
 */
export const useFilerEventStore = defineStore("filer-event", () => {
  /** 最後の fsChange イベント。relDir は worktree 相対パスで、直下は `""`（Swift SSOT） */
  const fsChangeEvent = ref<{ version: number; relDir: string }>();
  let fsChangeVersion = 0;
  function emitFsChange(relDir: string) {
    fsChangeVersion++;
    fsChangeEvent.value = { version: fsChangeVersion, relDir };
  }

  /** gitStatusChange の発火カウンタ。実データ（gitStatuses）は useGitStatusStore にある */
  const gitStatusChangeVersion = ref(0);
  function emitGitStatusChange() {
    gitStatusChangeVersion.value++;
  }

  return {
    fsChangeEvent,
    gitStatusChangeVersion,
    emitFsChange,
    emitGitStatusChange,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFilerEventStore, import.meta.hot));
}
