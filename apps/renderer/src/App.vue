<doc lang="md">
アプリケーションのルート。MainLayout を render し、各 feature の app-scope な購読・watcher を起動する。

具体的なロジックは各 feature の composable に閉じ、ここでは bootstrap の呼び出しだけを行う。
</doc>

<script setup lang="ts">
import { useFsWatchSync } from "./features/filer";
import { MainLayout, useCommandErrorBridge, useNotifySubscription } from "./features/layout";
import { useGozdOpenHandler, useRepoContextKey } from "./features/sidebar";
import { useGitStatusSync } from "./features/worktree";
import { useKeyBindings } from "./shared/command";

useKeyBindings();
useNotifySubscription();
useCommandErrorBridge();
useGozdOpenHandler();
useRepoContextKey();
useFsWatchSync();
useGitStatusSync();
</script>

<template>
  <MainLayout />
</template>
