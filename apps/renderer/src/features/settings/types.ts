/** 設定スキーマの型定義 */

/** ウィジェット共通のメタデータ */
interface SettingBase {
  /** 表示ラベル */
  label: string;
  /** 説明文 */
  description?: string;
}

/** boolean → トグルスイッチ */
export interface BooleanSetting extends SettingBase {
  widget: "boolean";
  defaultValue: boolean;
}

/** number → スライダー */
export interface NumberSetting extends SettingBase {
  widget: "number";
  defaultValue: number;
  min: number;
  max: number;
  step: number;
}

/** 列挙値 → セレクトボックス */
export interface EnumSetting extends SettingBase {
  widget: "enum";
  defaultValue: string;
  options: readonly string[] | (() => readonly string[]);
}

/** 文字列 → テキスト入力 */
export interface StringSetting extends SettingBase {
  widget: "string";
  defaultValue: string;
  placeholder?: string;
}

/** 複数行文字列 → テキストエリア（改行を保持する。stringArray と違い分割・trim しない） */
export interface TextSetting extends SettingBase {
  widget: "text";
  defaultValue: string;
  placeholder?: string;
}

/** 文字列配列 → テキストエリア（改行区切り） */
export interface StringArraySetting extends SettingBase {
  widget: "stringArray";
  defaultValue: string[];
  placeholder?: string;
}

/** glob → boolean マップ → 行リスト（glob 入力 + 有効トグル + 削除）。
 * VS Code の files.watcherExclude 相当。false で seed 済み default を無効化できる */
export interface StringBooleanMapSetting extends SettingBase {
  widget: "stringBooleanMap";
  defaultValue: Record<string, boolean>;
  placeholder?: string;
}

/**
 * VOICEVOX のキャラ + スタイル選択 → 2 段 select。
 * widget 内部で voicevox store と直結するため defaultValue / dot-key 経由の値は持たない。
 */
export interface VoicevoxSpeakerSetting extends SettingBase {
  widget: "voicevoxSpeaker";
}

export type SettingDefinition =
  | BooleanSetting
  | NumberSetting
  | EnumSetting
  | StringSetting
  | TextSetting
  | StringArraySetting
  | StringBooleanMapSetting
  | VoicevoxSpeakerSetting;

/** 設定セクション（グループ化） */
export interface SettingSection {
  title: string;
  settings: Record<string, SettingDefinition>;
}
