import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

export const useAppStore = defineStore("app", () => {
  const channel = ref<string>();

  const isDev = computed(() => channel.value === "dev");

  function setChannel(newChannel: string) {
    channel.value = newChannel;
  }

  return {
    channel,
    isDev,
    setChannel,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAppStore, import.meta.hot));
}
