/**
 * ダッシュボードの開閉シグナル。module singleton。
 * dialog の open/close は DashboardDialog が native `<dialog>` を SSOT に持ち、
 * ここは「開け」を showSignal の bump で伝えるだけ (search / file-picker と同流儀)。
 */
import { ref } from "vue";

const showSignal = ref(0);

function show(): void {
  showSignal.value++;
}

export function useDashboard() {
  return { showSignal, show };
}
