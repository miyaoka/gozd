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
  /**
   * ref の色を決める lane index。branch 名単位で固定 (local と remote of 同 branch は同 hue、
   * out-of-sync で異 commit に乗っていても hue は揃う)。tag は branch とは独立なので
   * lane 色を使わない (RefBadge 側で fallback class が当たる)。
   */
  laneColorIndex: number;
}
