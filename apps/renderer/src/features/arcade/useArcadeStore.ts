// arcade (ゲームジュース層) の設定 store。
//
// 永続化は AppConfig (config.json) に乗せ、native (proto3 JSON) を SSOT とする。
// renderer からは settings の RPC (rpcLoadAppConfig / rpcSaveAppConfig) 経由で読み書きする。
// gozd の「renderer 永続化は native RPC 経由」規約 (architecture.md) に従い localStorage は使わない。
// 保存形は VOICEVOX 設定と同じ read-modify-write (自セクションのみ更新し他を壊さない)。

import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { rpcLoadAppConfig, rpcSaveAppConfig } from "../settings";

/** sfx の既定値。config.arcade 未設定 (初インストール) のとき ON に倒す */
const DEFAULT_SFX_ENABLED = true;

export const useArcadeStore = defineStore("arcade", () => {
  const sfxEnabled = ref(DEFAULT_SFX_ENABLED);

  // 起動時に設定を読み込む。未設定 (proto3 optional が undefined) は default (ON) のまま据え置く
  void tryCatch(rpcLoadAppConfig()).then((result) => {
    if (!result.ok) return;
    const cfg = result.value.config?.arcade;
    if (cfg?.sfxEnabled !== undefined) sfxEnabled.value = cfg.sfxEnabled;
  });

  // read-modify-write で他セクション (terminal / preview / voicevox) を壊さず arcade だけ更新する
  async function save() {
    const loadResult = await tryCatch(rpcLoadAppConfig());
    if (!loadResult.ok) return;
    const config = loadResult.value.config ?? {
      terminal: undefined,
      preview: undefined,
      voicevox: undefined,
      arcade: undefined,
    };
    config.arcade = { sfxEnabled: sfxEnabled.value };
    void tryCatch(rpcSaveAppConfig(config));
  }

  watch(sfxEnabled, () => {
    void save();
  });

  function toggleSfx() {
    sfxEnabled.value = !sfxEnabled.value;
  }

  return { sfxEnabled, toggleSfx };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useArcadeStore, import.meta.hot));
}
