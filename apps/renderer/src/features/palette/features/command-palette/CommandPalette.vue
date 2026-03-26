<doc lang="md">
Command palette dialog. Displays a searchable list of registered commands with their keybindings.

## Behavior

- Opens via `commandPalette.show` command (Cmd+Shift+P)
- Filters commands by substring match on label
- Arrow keys navigate the list, Enter executes the selected command
- Escape or clicking the backdrop closes the dialog
- Positioned at top-center of the viewport
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { isIMEActive, useCommandRegistry, useContextKeys } from "../../../../shared/command";
import { useListNavigation } from "../../useListNavigation";
import { formatKeyBinding, getKeyBindingMap } from "./keyBindingDisplay";

const registry = useCommandRegistry();
const contextKeys = useContextKeys();
const dialogRef = useTemplateRef<HTMLDialogElement>("dialog");
const inputRef = useTemplateRef<HTMLInputElement>("input");
const listRef = useTemplateRef<HTMLUListElement>("list");

const query = ref("");
const keyBindingMap = getKeyBindingMap();

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
    <div class="w-[480px] overflow-hidden rounded-lg border border-zinc-600 bg-zinc-800 shadow-2xl">
      <div class="border-b border-zinc-700 p-2">
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Type a command..."
          aria-label="Search commands"
          class="w-full bg-transparent px-2 py-1 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
        />
      </div>
      <ul v-if="filteredCommands.length > 0" ref="list" class="max-h-[300px] overflow-y-auto py-1">
        <li
          v-for="(cmd, i) in filteredCommands"
          :key="cmd.id"
          class="flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm"
          :class="
            i === selectedIndex ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-700/50'
          "
          @click="
            () => {
              selectedIndex = i;
              executeSelected();
            }
          "
          @pointerenter="selectedIndex = i"
        >
          <span>{{ cmd.label }}</span>
          <kbd
            v-if="keyBindingMap.get(cmd.id)"
            class="ml-4 shrink-0 rounded-sm bg-zinc-900 px-1.5 py-0.5 font-mono text-xs text-zinc-400"
          >
            {{ formatKeyBinding(keyBindingMap.get(cmd.id)!) }}
          </kbd>
        </li>
      </ul>
      <div v-else class="px-3 py-4 text-center text-sm text-zinc-500">No matching commands</div>
    </div>
  </dialog>
</template>

<style scoped>
/* dialog をビューポート上部中央に配置 */
._command-palette-dialog {
  padding: 0;
  border: none;
  background: transparent;
  margin: 15vh auto 0;
}

._command-palette-dialog::backdrop {
  background: rgb(0 0 0 / 30%);
}
</style>
