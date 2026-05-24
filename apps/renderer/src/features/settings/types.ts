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

/** 文字列配列 → テキストエリア（改行区切り） */
export interface StringArraySetting extends SettingBase {
  widget: "stringArray";
  defaultValue: string[];
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
  | StringArraySetting
  | VoicevoxSpeakerSetting;

/** 設定セクション（グループ化） */
export interface SettingSection {
  title: string;
  settings: Record<string, SettingDefinition>;
}
