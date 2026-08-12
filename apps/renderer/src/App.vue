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
  useMainDebugSubscription,
  useNotifySubscription,
  useRpcListenerErrorBridge,
  useTitleContextSync,
} from "./features/layout";
import { MyWorkPanel } from "./features/my-work";
import { UndockedPreviewLayer } from "./features/preview";
import { ServerListPanel } from "./features/server";
import { UndockedLogLayer } from "./features/session-log";
import { useGozdOpenHandler, useRepoContextKey } from "./features/sidebar";
import { claudeStateKeyOf } from "./features/terminal";
import { useGitStatusSync, useRemoteFetchSync } from "./features/worktree";
import { useKeyBindings } from "./shared/command";

useKeyBindings();
useNotifySubscription();
useMainDebugSubscription();
useCommandErrorBridge();
useRpcListenerErrorBridge();
useGozdOpenHandler();
useRepoContextKey();
useFsWatchSync();
// worktree は terminal を知らない。「dir の Claude 状態が動いたら git status を取り直す」の
// 状態源だけを composition root で配線する
useGitStatusSync({ claudeStateKeyOf });
useRemoteFetchSync();
useTitleContextSync();
</script>

<template>
  <MainLayout />
  <ServerListPanel />
  <MyWorkPanel />
  <EventLogPanel />
  <UndockedLogLayer />
  <UndockedPreviewLayer />
  <ArcadeLayer />
</template>
