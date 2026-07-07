// ユーザー設定。`~/.config/gozd/config.json` に永続化される。
//
// 設計判断: セクションをネスト型にして型を持たせる。永続化ファイルの読み書きは
// main 側 stores.ts が行い、旧ファイルの欠落フィールドは load 時に default 充填する
// （「フィールド不在 = default 値」という旧 proto3 JSON の永続ファイル契約を維持する）。

import type { EmptyMessage } from "./common";

export interface AppConfig {
  terminal: TerminalConfig;
  preview: PreviewConfig;
  voicevox: VoicevoxConfig;
  arcade: ArcadeConfig;
  /** ファイル監視から除外する glob マップ（VS Code の `files.watcherExclude` 相当）。
   * key = 監視 root からの相対 glob、value = true で除外 / false で除外解除。
   * gozd は VS Code の user⊕workspace マージを持たず global 1 枚のみ。初期値は
   * stores.ts が seed する（`.git` 内部の高churn 領域。ref シグナルは含まない）。 */
  watcherExclude: Record<string, boolean>;
}

interface TerminalConfig {
  /** 空文字列はデフォルトテーマ（renderer 側 fallback） */
  theme: string;
  /** 空文字列なら xterm デフォルト */
  fontFamily: string;
  /** 0 なら xterm デフォルト */
  fontSize: number;
}

interface PreviewConfig {
  /** 散文 (markdown 本文等) 用。空文字列なら app デフォルト (sans) */
  fontFamily: string;
  fontSize: number;
  /** コード (code preview / diff / markdown コードブロック) 用。
   * 空文字列なら monospace スタック (--font-mono) に fallback */
  codeFontFamily: string;
}

interface VoicevoxConfig {
  enabled: boolean;
  speedScale: number;
  volumeScale: number;
  /** 未設定なら renderer 側 default にフォールバック。
   * VOICEVOX の正規 style ID 0 (四国めたん あまあま) と未設定を区別するため optional。 */
  speakerId?: number;
}

interface ArcadeConfig {
  /** ゲームジュース層の効果音 ON/OFF。未設定 (初インストール) と明示 false (ユーザーが
   * ミュート) を区別するため optional。未設定なら renderer 側 default (ON) に倒す。 */
  sfxEnabled?: boolean;
}

export type LoadAppConfigRequest = EmptyMessage;

export interface LoadAppConfigResponse {
  config: AppConfig;
}

export interface SaveAppConfigRequest {
  config: AppConfig;
}

export type SaveAppConfigResponse = EmptyMessage;
