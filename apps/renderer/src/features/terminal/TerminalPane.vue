<doc lang="md">
ターミナルバックエンド切り替えラッパー。

ghostty-web と xterm.js を動的に切り替える。
バックエンドを変更すると PTY を再生成して新しいターミナルを開く。
</doc>

<script setup lang="ts">
import { shallowRef } from "vue";
import type { Component } from "vue";
import GhosttyTerminal from "./GhosttyTerminal.vue";
import XtermTerminal from "./XtermTerminal.vue";

type TerminalBackend = "ghostty" | "xterm";

interface BackendEntry {
  component: Component;
  label: string;
}

const BACKENDS: Record<TerminalBackend, BackendEntry> = {
  ghostty: { component: GhosttyTerminal, label: "Ghostty" },
  xterm: { component: XtermTerminal, label: "xterm" },
};

const BACKEND_KEYS: TerminalBackend[] = ["xterm", "ghostty"];

const currentBackend = shallowRef<TerminalBackend>("xterm");
</script>

<template>
  <div class="flex size-full flex-col">
    <div class="flex shrink-0 gap-1 px-2 py-1">
      <button
        v-for="key in BACKEND_KEYS"
        :key="key"
        class="rounded-sm px-2 py-0.5 text-xs"
        :class="
          currentBackend === key
            ? 'bg-zinc-600 text-zinc-100'
            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'
        "
        @click="currentBackend = key"
      >
        {{ BACKENDS[key].label }}
      </button>
    </div>
    <div class="min-h-0 flex-1">
      <component :is="BACKENDS[currentBackend].component" :key="currentBackend" />
    </div>
  </div>
</template>
