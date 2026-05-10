<doc lang="md">
サイドバーの BRANCHES セクション。worktree 化されていないローカルブランチの一覧を表示する。
</doc>

<script setup lang="ts">
defineProps<{
  branches: string[];
}>();

const emit = defineEmits<{
  openMenu: [anchorEl: HTMLElement, branch: string];
}>();

function onMenuClick(event: MouseEvent, branch: string) {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    emit("openMenu", target, branch);
  }
}
</script>

<template>
  <div v-if="branches.length > 0" class="mt-4 flex flex-col">
    <h2 class="mb-1 text-xs font-medium text-zinc-500">BRANCHES</h2>

    <div
      v-for="branch in branches"
      :key="branch"
      class="group/br grid grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2 text-sm text-zinc-500 hover:bg-zinc-800"
    >
      <span class="icon-[lucide--git-branch] text-base" />
      <span class="truncate">{{ branch }}</span>
      <button
        aria-label="Menu"
        class="grid size-6 place-items-center self-center rounded-sm text-zinc-600 opacity-0 transition-opacity group-focus-within/br:opacity-100 group-hover/br:opacity-100 hover:text-zinc-300"
        @click.stop="onMenuClick($event, branch)"
      >
        <span class="icon-[lucide--ellipsis-vertical] text-sm" />
      </button>
    </div>
  </div>
</template>
