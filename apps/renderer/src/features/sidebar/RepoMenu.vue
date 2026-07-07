<doc lang="md">
repo セクションヘッダの ⋮ ポップオーバーメニュー。現状は「Revive session」1 項目。
state は `useRepoMenu` (module singleton) 経由で SidebarPane と共有する。
Revive session は command registry 経由で `workspace.reviveSession` を rootDir 付きで dispatch
する。command はコマンドパレットからも起動でき (その場合 active repo が対象)、サイドバーからは
明示 rootDir を渡す — VSCode の SCM コマンド (clicked resource 優先 / 無ければ picker) と同型。
palette / command registry を直接 import せず command bus 経由にすることで sidebar→palette の
import 循環を避ける。
</doc>

<script setup lang="ts">
import { useCommandRegistry } from "../../shared/command";
import { useRepoMenu } from "./useRepoMenu";
import IconLucideHistory from "~icons/lucide/history";

const { Popover, context, close } = useRepoMenu();
const registry = useCommandRegistry();

function handleRevive() {
  if (!context.value) return;
  const { rootDir } = context.value;
  close();
  registry.execute("workspace.reviveSession", { rootDir });
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
    </template>
  </Popover>
</template>
