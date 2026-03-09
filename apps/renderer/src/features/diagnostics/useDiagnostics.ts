import type { FileDiagnostics, LspDiagnostic } from "@orkis/rpc";
import { computed, ref } from "vue";
import { useRpc } from "../rpc/useRpc";

/** severity 定数 */
const SEVERITY_ERROR = 1;
const SEVERITY_WARNING = 2;

/** ファイルごとの診断結果をリアクティブに保持する */
const diagnosticsMap = ref<Map<string, LspDiagnostic[]>>(new Map());

let subscribed = false;

/** RPC 購読を開始する（アプリ内で一度だけ） */
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;

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
}

export function useDiagnostics() {
  ensureSubscribed();

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

  return {
    diagnosticsMap,
    errorFiles,
    warningFiles,
    errorCount,
    warningCount,
  };
}
