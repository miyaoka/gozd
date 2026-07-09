/**
 * 設定モーダルの制御 composable（module singleton）。
 * モーダルの open/close 状態管理とコマンド登録を行う。
 */

import { ref } from "vue";
import { useCommandRegistry } from "../../shared/command";

export type SettingsTab = "global" | "project";

const isOpen = ref(false);
/** 開いたときに最初に表示するタブ。open() ごとに設定し直す */
const initialTab = ref<SettingsTab>("global");
/**
 * Project タブの対象 project dir を明示指定するオーバーライド。undefined なら
 * アクティブ worktree に追従する（コマンドパレット / Cmd+, 経由）。repo メニューから
 * 開いたときだけ、その repo の rootDir で対象を固定する（VSCode の SCM コマンドと
 * 同型: clicked resource 優先）。
 */
const targetProjectDir = ref<string | undefined>(undefined);

/** open のオプション。省略時は Global タブ / アクティブ worktree 追従で開く */
interface OpenOptions {
  tab?: SettingsTab;
  projectDir?: string;
}

function open(options: OpenOptions = {}) {
  initialTab.value = options.tab ?? "global";
  targetProjectDir.value = options.projectDir;
  isOpen.value = true;
}

function close() {
  isOpen.value = false;
}

/** command args から tab / 対象 repo（rootDir）を取り出す。未指定は undefined */
function parseOpenArgs(args: unknown): OpenOptions {
  if (typeof args !== "object" || args === null) return {};
  const { tab, rootDir } = args as { tab?: unknown; rootDir?: unknown };
  return {
    tab: tab === "project" || tab === "global" ? tab : undefined,
    projectDir: typeof rootDir === "string" && rootDir !== "" ? rootDir : undefined,
  };
}

/** コマンド登録。MainLayout で一度だけ呼び出す */
export function registerSettingsCommand(): () => void {
  const registry = useCommandRegistry();
  return registry.register("settings.open", {
    label: "Settings: Open",
    handler: (args?: unknown) => {
      open(parseOpenArgs(args));
      return true;
    },
  });
}

export function useSettingsModal() {
  return { isOpen, initialTab, targetProjectDir, open, close };
}
