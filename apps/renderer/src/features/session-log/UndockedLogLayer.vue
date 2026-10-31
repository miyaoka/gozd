<script setup lang="ts">
import UndockedLogWindow from "./UndockedLogWindow.vue";
import { useUndockedLog } from "./useUndockedLog";

const { logs } = useUndockedLog();
</script>

<template>
  <UndockedLogWindow v-for="log in logs" :key="log.id" :log="log" />
</template>
