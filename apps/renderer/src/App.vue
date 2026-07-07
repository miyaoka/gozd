<doc lang="md">
アプリケーションのルート。MainLayout を render し、各 feature の app-scope な購読・watcher を起動する。

具体的なロジックは各 feature の composable に閉じ、ここでは bootstrap の呼び出しだけを行う。
</doc>

<script setup lang="ts">
import { ArcadeLayer } from "./features/arcade";
import { EventLogPanel } from "./features/event-log";
import { useFsWatchSync } from "./features/filer";
import {
  MainLayout,
  useCommandErrorBridge,
  useNotifySubscription,
  useTitleContextSync,
} from "./features/layout";
import { ServerListPanel } from "./features/server";
import { useGozdOpenHandler, useRepoContextKey } from "./features/sidebar";
import { useGitStatusSync, useRemoteFetchSync } from "./features/worktree";
import { useKeyBindings } from "./shared/command";

useKeyBindings();
useNotifySubscription();
useCommandErrorBridge();
useGozdOpenHandler();
useRepoContextKey();
useFsWatchSync();
useGitStatusSync();
useRemoteFetchSync();
useTitleContextSync();
</script>

<template>
  <MainLayout />
  <ServerListPanel />
  <EventLogPanel />
  <ArcadeLayer />
</template>
