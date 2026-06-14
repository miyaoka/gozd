// arcade (ゲームジュース層) の設定 store。
//
// 永続化は AppConfig (config.json) に乗せ、native (proto3 JSON) を SSOT とする。
// renderer からは settings の updateAppConfig (直列化された RMW) 経由で書き、起動時のみ
// rpcLoadAppConfig で読む。gozd の「renderer 永続化は native RPC 経由」規約 (architecture.md)
// に従い localStorage は使わない。更新が他セクション (terminal / preview / voicevox) と
// 並行しても巻き戻らないよう、書き込みは updateAppConfig の単一キューに通す。

import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcLoadAppConfig, updateAppConfig } from "../settings";

/** sfx の既定値。config.arcade 未設定 (初インストール) のとき ON に倒す */
const DEFAULT_SFX_ENABLED = true;

export const useArcadeStore = defineStore("arcade", () => {
  const notify = useNotificationStore();
  const sfxEnabled = ref(DEFAULT_SFX_ENABLED);

  // 起動時に設定を読み込む。未設定 (proto3 optional が undefined) は default (ON) のまま据え置く
  void tryCatch(rpcLoadAppConfig()).then((result) => {
    if (!result.ok) {
      notify.error("Failed to load sound settings", result.error);
      return;
    }
    const cfg = result.value.config?.arcade;
    if (cfg?.sfxEnabled !== undefined) sfxEnabled.value = cfg.sfxEnabled;
  });

  // 書き込みは updateAppConfig 経由 (直列化 + 自セクションのみ mutate)。失敗は通知する
  async function save() {
    const result = await tryCatch(
      updateAppConfig((config) => {
        config.arcade = { sfxEnabled: sfxEnabled.value };
      }),
    );
    if (!result.ok) notify.error("Failed to save sound settings", result.error);
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
