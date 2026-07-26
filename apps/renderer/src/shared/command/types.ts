/**
 * コマンドシステムの型定義。
 * 循環 import を防ぐため、型はこのファイルに集約する。
 */

// --- コマンド ---

/** コマンドハンドラー。処理した場合 true、何もしなかった場合 false を返す */
type CommandHandler = (args?: unknown) => boolean;

/** label 付きコマンド記述子。label があるコマンドのみパレットに表示される */
export interface CommandDescriptor {
  /** コマンドパレットに表示する名前（例: "Terminal: Split Horizontal"） */
  label: string;
  handler: CommandHandler;
  /** コマンドの有効化条件。false の場合パレットに表示されず、実行もスキップされる */
  precondition?: string;
  /** 既定 keybinding。省略時はキー割り当てなし（パレット / 直接呼び出しのみ） */
  keybinding?: KeyBindingSpec;
}

/** register の第2引数: ハンドラ関数そのまま、または label 付き記述子 */
export type CommandInput = CommandHandler | CommandDescriptor;

/**
 * 既定 keybinding の宣言。コマンド ID を書く欄を register の第 1 引数だけに保つため、
 * 独立したテーブルではなくコマンド記述子に同居させる。
 */
interface KeyBindingSpec {
  /**
   * VS Code 互換形式: "cmd+d", "alt+cmd+up"。配列で同義キーを複数割り当てられる
   * (同じ意味の操作に別のキーを与える用途。異なる意味を 1 コマンドに束ねない)
   */
  key: string | string[];
  /**
   * キー割り当ての追加条件。実効条件は precondition との AND なので、
   * precondition で既に効いている key を再掲しない。
   * 同じキーを複数コマンドに割り当てるときは、実効条件が同時に真にならないように書く
   */
  when?: string;
}

/** register 時に parse 済みの keybinding */
export interface ResolvedKeyBinding {
  /** 宣言時の key 文字列 (宣言順)。パレットのキー表示に使う */
  keys: string[];
  strokes: KeyStroke[];
  /** precondition と when を AND 済みの実効条件 */
  when: When | undefined;
}

/** レジストリ内部で保持するコマンドエントリ */
export interface CommandEntry {
  id: string;
  label: string | undefined;
  handler: CommandHandler;
  /** パース済みの precondition AST */
  precondition: When | undefined;
  keybinding: ResolvedKeyBinding | undefined;
}

// --- キー入力 ---

export interface KeyStroke {
  /** 物理キーの e.code 値（"KeyD", "Digit2", "ArrowUp" 等） */
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

// --- Context Key ---

/**
 * context key の名前と値型のマッピング。when 条件で使える key の SSOT。
 * key を足すときは「その key が真であることが何を意味するか」を doc コメントで併記する
 * （when を書く側は名前だけでは意味を確定できないため）。
 */
export interface ContextMap {
  /** ターミナル leaf 内にフォーカスがある */
  terminalFocus: boolean;
  /** ファイルツリー（FilerPane）内にフォーカスがある */
  filerFocus: boolean;
  /** Preview popover が開いている */
  previewVisible: boolean;
  /** Preview に編集セッションが張られている（編集可能な content を表示中） */
  previewEditable: boolean;
  /** top layer のサーフェス（右ドックパネル / undock パネル）が 1 枚でも開いている */
  surfaceVisible: boolean;
  /** undock された in-app パネル内にフォーカスがある */
  floatingWindowFocused: boolean;
  /** undock された child window（別 OS ウィンドウ）が OS フォーカスを持つ */
  childWindowFocused: boolean;
  /** コマンドパレットが開いている */
  commandPaletteVisible: boolean;
  /** QuickPick が開いている */
  quickPickVisible: boolean;
  /** File picker（Go to File）が開いている */
  filePickerVisible: boolean;
  /** PR ピッカーが開いている */
  prPickerVisible: boolean;
  /** Issue ピッカーが開いている */
  issuePickerVisible: boolean;
  /** Revive ピッカーが開いている */
  revivePickerVisible: boolean;
  /** keydown を受けた document のフォーカスが input / textarea / contenteditable にある */
  inputFocused: boolean;
  /** 選択中の repo が git 管理下 */
  isGitRepo: boolean;
}

export type ContextKey = keyof ContextMap;

// --- When 条件（内部 AST） ---

export type When =
  | { type: "key"; key: ContextKey }
  | { type: "not"; value: When }
  | { type: "and"; values: readonly When[] }
  | { type: "or"; values: readonly When[] };
