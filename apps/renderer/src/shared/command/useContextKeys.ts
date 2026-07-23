/**
 * Context Key の管理。module singleton パターン。
 * keybinding の when 条件評価に使用する。
 */
import { ref } from "vue";
import type { ContextKey, ContextMap, When } from "./types";

const INITIAL_STATE: ContextMap = {
  terminalFocus: false,
  filerFocus: false,
  previewVisible: false,
  previewEditable: false,
  childWindowFocused: false,
  commandPaletteVisible: false,
  quickPickVisible: false,
  filePickerVisible: false,
  prPickerVisible: false,
  issuePickerVisible: false,
  revivePickerVisible: false,
  inputFocused: false,
  isGitRepo: false,
};

const state = ref<ContextMap>({ ...INITIAL_STATE });

function get<K extends ContextKey>(key: K): ContextMap[K] {
  return state.value[key];
}

function set<K extends ContextKey>(key: K, value: ContextMap[K]): void {
  state.value[key] = value;
}

/** When 条件を現在の context key 状態で評価する。undefined は常に true */
function evaluate(when: When | undefined): boolean {
  if (when === undefined) return true;

  switch (when.type) {
    case "key":
      return state.value[when.key] === true;
    case "not":
      return !evaluate(when.value);
    case "and":
      return when.values.every((v) => evaluate(v));
    case "or":
      return when.values.some((v) => evaluate(v));
  }
}

/** HMR / テスト用。全 context key を初期値にリセットする */
function reset(): void {
  state.value = { ...INITIAL_STATE };
}

export function useContextKeys() {
  return { get, set, evaluate, reset };
}
