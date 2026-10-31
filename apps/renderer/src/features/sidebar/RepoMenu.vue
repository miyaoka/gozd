<script setup lang="ts">
import { useCommandRegistry } from "../../shared/command";
import { useRepoMenu } from "./useRepoMenu";
import IconLucideHistory from "~icons/lucide/history";
import IconLucideSettings from "~icons/lucide/settings";

const { Popover, context, close } = useRepoMenu();
const registry = useCommandRegistry();

function handleRevive() {
  if (!context.value) return;
  const { rootDir } = context.value;
  close();
  registry.execute("workspace.reviveSession", { rootDir });
}

function handleProjectSettings() {
  if (!context.value) return;
  const { rootDir } = context.value;
  close();
  registry.execute("settings.open", { tab: "project", rootDir });
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="context">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleRevive"
      >
        <IconLucideHistory class="text-xs" />
        Revive session
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleProjectSettings"
      >
        <IconLucideSettings class="text-xs" />
        Project settings
      </button>
    </template>
  </Popover>
</template>
