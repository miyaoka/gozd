/** プロジェクト設定（ProjectConfig）のスキーマ定義 */

import type { SettingSection } from "./types";

export const projectSettingsSections: readonly SettingSection[] = [
  {
    title: "Worktree",
    settings: {
      worktreeSymlinks: {
        widget: "stringArray",
        label: "Symlinks",
        description: "Paths to symlink from main repository when creating worktrees",
        defaultValue: [],
        placeholder: ".claude\n.env.local",
      },
    },
  },
];
