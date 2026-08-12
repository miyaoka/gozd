/**
 * QuickPick の制御を外部に公開する module singleton composable。
 * QuickPick.vue がリアクティブに currentOptions / showSignal を読み取り、
 * 外部のコマンドハンドラーは show() を呼ぶだけで dialog が開く。
 *
 * 描画は palette の QuickPick.vue が担い、mount されていなければ show() は無音で
 * 何も起きない（MainLayout が常設 mount する契約）。描画側を shared/ui に同居
 * できないのは、QuickPick.vue が shared/command に依存し shared 間依存が禁止のため。
 */

import { ref } from "vue";

export interface QuickPickItem {
  label: string;
  description?: string;
  /** true の場合、セクション区切り行として表示される（選択不可） */
  separator?: boolean;
}

interface QuickPickOptions {
  items: QuickPickItem[];
  placeholder?: string;
  /** Index of the initially active item */
  activeIndex?: number;
  /** Called when the highlighted item changes (200ms debounce) */
  onHighlight: (item: QuickPickItem) => void;
  /** Called when the user accepts the selection */
  onAccept: (item: QuickPickItem) => void;
  /** Called when the user cancels (Escape or backdrop click) */
  onCancel: () => void;
}

/** Current options. QuickPick.vue watches this reactively */
const currentOptions = ref<QuickPickOptions>();

/** Signal to trigger dialog open. Incremented on each show() call */
const showSignal = ref(0);

export function useQuickPick() {
  function show(options: QuickPickOptions) {
    currentOptions.value = options;
    showSignal.value++;
  }

  return { show, currentOptions, showSignal };
}
