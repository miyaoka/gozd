<doc lang="md">
登録済みコマンドを名前で探して実行する入口。

**候補に出すかどうかの判断は持たない**。何が一覧に載るかは registry の列挙が決め
（[docs/command.md](../../../../../../../docs/command.md) が SSOT）、ここはその集合を名前で
絞り込むだけ。ここに条件を足すと、キーからは実行できるのにパレットには出ない（あるいは
その逆）という非対称が生まれる。

- コマンドの実行はダイアログを閉じてから行う。開いたまま走らせると、コマンド自身が開く
  サーフェスより手前にモーダルが残り、実行結果が見えない
- 変換確定のためのキー入力は選択操作として扱わない。日本語入力の確定が、そのままコマンド
  実行になってしまうため
- キー割り当てを持つ候補には、それを併記する。あるコマンドにキーが割り当てられているかを
  一覧で確認できる唯一の場所でもある
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useCommandRegistry, useContextKeys } from "../../../../shared/command";
import { useListNavigation } from "../../useListNavigation";
import { formatKeyBinding } from "./keyBindingDisplay";

const registry = useCommandRegistry();
const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLUListElement>("list");

const query = ref("");

const filteredCommands = computed(() => {
  const commands = registry.listForPalette();
  const q = query.value.toLowerCase();
  if (q === "") return [...commands];
  return commands.filter((cmd) => cmd.label?.toLowerCase().includes(q));
});

const itemCount = computed(() => filteredCommands.value.length);
const { selectedIndex, move, movePage, reset, scrollToSelected } = useListNavigation({
  listRef,
  itemCount,
});

/** Reset selection when filter changes */
watch(filteredCommands, () => {
  reset();
});

function show() {
  const dialog = dialogRef.value;
  if (dialog === null || dialog.open) return;
  query.value = "";
  reset();
  dialog.showModal();
  contextKeys.set("commandPaletteVisible", true);
  nextTick(() => {
    inputRef.value?.focus();
    scrollToSelected();
  });
}

function close() {
  dialogRef.value?.close();
  contextKeys.set("commandPaletteVisible", false);
}

function executeSelected() {
  const cmd = filteredCommands.value[selectedIndex.value];
  if (cmd === undefined) return;
  close();
  registry.execute(cmd.id);
}

function handleKeydown(e: KeyboardEvent) {
  if (isIMEActive(e)) return;

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(-1);
      break;
    case "PageDown":
      e.preventDefault();
      movePage(1);
      break;
    case "PageUp":
      e.preventDefault();
      movePage(-1);
      break;
    case "Enter":
      e.preventDefault();
      executeSelected();
      break;
  }
}

/** Close on backdrop click (click on dialog element itself, not its children) */
useEventListener(dialogRef, "click", (e: MouseEvent) => {
  if (e.target === dialogRef.value) {
    close();
  }
});

/** Register command for opening the palette */
const disposeShow = registry.register("commandPalette.show", {
  label: "Show All Commands",
  keybinding: { key: "shift+cmd+p" },
  handler: () => {
    show();
    return true;
  },
});

onUnmounted(disposeShow);
</script>

<template>
  <dialog
    ref="dialog"
    class="_command-palette-dialog"
    aria-label="Command palette"
    @keydown="handleKeydown"
    @close="contextKeys.set('commandPaletteVisible', false)"
  >
    <div
      class="w-[480px] overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
    >
      <div class="border-b border-border p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Type a command..."
          aria-label="Search commands"
          class="w-full bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-foreground-low"
        />
      </div>
      <ul v-if="filteredCommands.length > 0" ref="list" class="max-h-[300px] overflow-y-auto py-1">
        <li
          v-for="(cmd, i) in filteredCommands"
          :key="cmd.id"
          class="flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm"
          :class="
            i === selectedIndex
              ? 'bg-element text-foreground'
              : 'text-foreground hover:bg-element-hover'
          "
          @click="
            () => {
              selectedIndex = i;
              executeSelected();
            }
          "
        >
          <span>{{ cmd.label }}</span>
          <kbd
            v-if="cmd.keybinding"
            class="ml-4 shrink-0 rounded-sm bg-background px-1.5 py-0.5 font-mono text-xs text-foreground-low"
          >
            {{ cmd.keybinding.keys.map(formatKeyBinding).join(" / ") }}
          </kbd>
        </li>
      </ul>
      <div v-else class="px-3 py-4 text-center text-sm text-foreground-low">
        No matching commands
      </div>
    </div>
  </dialog>
</template>

<style scoped>
/* dialog をビューポート上部中央に配置 */
._command-palette-dialog {
  margin: 15vh auto 0;
}

._command-palette-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
