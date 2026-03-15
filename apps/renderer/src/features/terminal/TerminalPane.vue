<doc lang="md">
ターミナルペイン。xterm.js ベースのターミナルエミュレータを表示する。
</doc>

<script setup lang="ts">
import { useTemplateRef } from "vue";
import XtermTerminal from "./XtermTerminal.vue";

const xtermRef = useTemplateRef<InstanceType<typeof XtermTerminal>>("xtermRef");

function suspendAutoFit() {
  xtermRef.value?.suspendAutoFit();
}

function resumeAutoFit() {
  xtermRef.value?.resumeAutoFit();
}

defineExpose({ suspendAutoFit, resumeAutoFit });
</script>

<template>
  <div class="flex size-full flex-col">
    <div class="min-h-0 flex-1">
      <XtermTerminal ref="xtermRef" />
    </div>
  </div>
</template>
