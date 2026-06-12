// arcade (ゲームジュース層) の設定 store。module singleton パターン。
//
// 永続化は localStorage を使う。gozd の永続データは native (proto3 JSON) が原則だが、
// この層は失っても困らない演出設定であり、RPC + proto schema を増やす重みに見合わない
// ため renderer 内で完結させる判断。

import { ref, watch } from "vue";

const STORAGE_KEY = "gozd-arcade";

interface ArcadeConfig {
  sfxEnabled: boolean;
}

function load(): ArcadeConfig {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return { sfxEnabled: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "sfxEnabled" in parsed) {
      return { sfxEnabled: (parsed as ArcadeConfig).sfxEnabled === true };
    }
  } catch {
    // 壊れた値は既定値で上書きされる (後方互換を作らない方針と整合)
  }
  return { sfxEnabled: true };
}

const sfxEnabled = ref(load().sfxEnabled);

watch(sfxEnabled, (value) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sfxEnabled: value }));
});

export function useArcadeStore() {
  return {
    sfxEnabled,
    toggleSfx: () => {
      sfxEnabled.value = !sfxEnabled.value;
    },
  };
}
