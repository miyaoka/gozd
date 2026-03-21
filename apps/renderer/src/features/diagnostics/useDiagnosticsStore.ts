import type { FileDiagnostics, LspDiagnostic } from "@gozd/rpc";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { useRpc } from "../../shared/rpc";

/** severity 定数 */
const SEVERITY_ERROR = 1;
const SEVERITY_WARNING = 2;

export const useDiagnosticsStore = defineStore("diagnostics", () => {
  const diagnosticsMap = ref<Map<string, LspDiagnostic[]>>(new Map());

  /** RPC 購読を開始する（store 初期化時に一度だけ） */
  const { onLspDiagnostics } = useRpc();
  onLspDiagnostics((payload: FileDiagnostics) => {
    const map = new Map(diagnosticsMap.value);
    if (payload.diagnostics.length === 0) {
      map.delete(payload.relPath);
    } else {
      map.set(payload.relPath, payload.diagnostics);
    }
    diagnosticsMap.value = map;
  });

  /** エラーがあるファイルの一覧（severity=1 のみ） */
  const errorFiles = computed(() => {
    const result: Array<{ relPath: string; diagnostics: LspDiagnostic[] }> = [];
    for (const [relPath, diags] of diagnosticsMap.value) {
      const errors = diags.filter((d) => d.severity === SEVERITY_ERROR);
      if (errors.length > 0) {
        result.push({ relPath, diagnostics: errors });
      }
    }
    return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
  });

  /** 警告があるファイルの一覧（severity=2 のみ） */
  const warningFiles = computed(() => {
    const result: Array<{ relPath: string; diagnostics: LspDiagnostic[] }> = [];
    for (const [relPath, diags] of diagnosticsMap.value) {
      const warnings = diags.filter((d) => d.severity === SEVERITY_WARNING);
      if (warnings.length > 0) {
        result.push({ relPath, diagnostics: warnings });
      }
    }
    return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
  });

  /** エラー総数 */
  const errorCount = computed(() =>
    errorFiles.value.reduce((sum, f) => sum + f.diagnostics.length, 0),
  );

  /** 警告総数 */
  const warningCount = computed(() =>
    warningFiles.value.reduce((sum, f) => sum + f.diagnostics.length, 0),
  );

  /** worktree 切り替え時に全診断をクリアする */
  function clear() {
    diagnosticsMap.value = new Map();
  }

  return {
    diagnosticsMap,
    errorFiles,
    warningFiles,
    errorCount,
    warningCount,
    clear,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDiagnosticsStore, import.meta.hot));
}
