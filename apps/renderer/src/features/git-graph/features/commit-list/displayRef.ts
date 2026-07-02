export interface DisplayRef {
  label: string;
  type: "local" | "remote" | "synced" | "tag";
  /** origin と同じコミットにあるか */
  isSynced: boolean;
  /** ローカルとリモートが別コミットに存在するか */
  isOutOfSync: boolean;
  /** カレントブランチか */
  isCurrent: boolean;
  /** デフォルトブランチか */
  isDefault: boolean;
}
