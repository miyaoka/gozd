import { ref } from "vue";

/** モジュールレベルで保持するため HMR でも状態が消えない */
const dir = ref<string>();
const file = ref<string>();

export function useWorkspace() {
  function setOpen(newDir: string, newFile?: string) {
    dir.value = newDir;
    file.value = newFile;
  }

  return { dir, file, setOpen };
}
