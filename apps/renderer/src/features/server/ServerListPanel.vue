<doc lang="md">
実行中サーバー (TCP LISTEN プロセス) の一覧パネル (issue #768)。

native titlebar のトグルボタン → `toggleServerPanel` push → `useServerStore.isOpen` で開閉する
右ドック型オーバーレイ。port 競合調査が主目的なので、各サーバーを **port 単位の行**に展開して
port 昇順で並べ、同一 port が複数プロセスに跨るときは衝突候補として警告色で示す。

行クリックで該当サーバーの worktree を active にし、live なら端末ペインへフォーカスする。
gozd 外 (external) は worktree を持たないのでクリック不可。

ドック型 (背景を覆わない) にしているのは、ターミナルを見ながら port の主を調べる用途のため。
ESC か閉じるボタンで閉じる。
</doc>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import type { ServerAttributionKind } from "./rpc";
import { useServerStore } from "./useServerStore";
import IconLucideServer from "~icons/lucide/server";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideX from "~icons/lucide/x";

const serverStore = useServerStore();
const repoStore = useRepoStore();
const terminalStore = useTerminalStore();
const worktreeStore = useWorktreeStore();

interface ServerRow {
  key: string;
  port: number;
  pid: number;
  name: string;
  attribution: ServerAttributionKind;
  worktreePath: string;
  ptyId: number;
  repoName: string;
  worktreeName: string;
  conflict: boolean;
}

/** worktree path → 表示用の repo 名 / worktree 名。未解決なら basename にフォールバック。 */
function resolveNames(worktreePath: string): { repoName: string; worktreeName: string } {
  if (worktreePath === "") return { repoName: "", worktreeName: "" };
  const repo = repoStore.findRepoOwning(worktreePath);
  const wt = repo?.worktrees.find((w) => w.path === worktreePath);
  const branch = wt?.branch ?? "";
  const worktreeName =
    branch !== "" ? branch.replace(/^refs\/heads\//, "") : basename(worktreePath);
  return { repoName: repo?.repoName ?? "", worktreeName };
}

function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  const [last = path] = parts.slice(-1);
  return last;
}

const ATTRIBUTION_LABEL: Record<ServerAttributionKind, string> = {
  live: "live",
  orphaned: "閉じた端末",
  external: "gozd 外",
};

const ATTRIBUTION_CLASS: Record<ServerAttributionKind, string> = {
  live: "text-success-text",
  orphaned: "text-warning-text",
  external: "text-foreground-low",
};

// 各サーバーを port 単位の行に展開し、port 昇順 → pid 昇順で安定ソートする。
// 同一 port が複数行に現れたら衝突候補としてマークする。
const rows = computed<ServerRow[]>(() => {
  const flat = serverStore.servers.flatMap((server) => {
    const names = resolveNames(server.worktreePath);
    return server.ports.map((port) => ({
      key: `${server.pid}-${port}`,
      port,
      pid: server.pid,
      name: server.name,
      attribution: server.attribution,
      worktreePath: server.worktreePath,
      ptyId: server.ptyId,
      repoName: names.repoName,
      worktreeName: names.worktreeName,
      conflict: false,
    }));
  });

  const portCounts = new Map<number, number>();
  for (const row of flat) portCounts.set(row.port, (portCounts.get(row.port) ?? 0) + 1);
  for (const row of flat) row.conflict = (portCounts.get(row.port) ?? 0) > 1;

  return flat.sort((a, b) => (a.port !== b.port ? a.port - b.port : a.pid - b.pid));
});

function onRowClick(row: ServerRow): void {
  // external は帰属 worktree を持たないので開けない。
  if (row.worktreePath === "") return;
  terminalStore.viewMode = "wt";
  worktreeStore.setOpen(row.worktreePath);
  // live なら該当端末ペインへフォーカスする (ptyId は帰属先 PTY)。
  if (row.ptyId > 0) {
    const leafId = terminalStore.getLeafIdByPtyId(row.ptyId);
    if (leafId !== undefined) terminalStore.focusPane(leafId);
  }
  serverStore.close();
}

// ドック型で背景を覆わないため OS の auto dismiss が無い。ESC を自前で受けて閉じる。
function onKeydown(e: KeyboardEvent): void {
  if (e.code === "Escape" && serverStore.isOpen) {
    e.preventDefault();
    serverStore.close();
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div
    v-if="serverStore.isOpen"
    class="fixed inset-y-0 right-0 z-40 flex w-[480px] flex-col border-l border-border bg-panel shadow-xl"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideServer class="size-4 text-foreground-low" />
      <h2 class="flex-1 text-sm font-medium text-foreground">実行中サーバー</h2>
      <button
        type="button"
        aria-label="Close"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="serverStore.close()"
      >
        <IconLucideX class="size-4" />
      </button>
    </header>

    <div v-if="rows.length === 0" class="px-3 py-8 text-center text-xs text-foreground-low">
      LISTEN 中の TCP サーバーは検出されていません
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <!-- header row -->
      <div
        class="sticky top-0 grid grid-cols-[64px_1fr_1.4fr_72px] gap-2 border-b border-border bg-panel px-3 py-1.5 text-[10px] font-medium tracking-wide text-foreground-low uppercase"
      >
        <span>Port</span>
        <span>プロセス</span>
        <span>repo / worktree</span>
        <span class="text-right">種別</span>
      </div>
      <button
        v-for="row in rows"
        :key="row.key"
        type="button"
        :disabled="row.worktreePath === ''"
        class="grid w-full grid-cols-[64px_1fr_1.4fr_72px] items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors not-disabled:cursor-pointer not-disabled:hover:bg-element-hover disabled:cursor-default"
        @click="onRowClick(row)"
      >
        <span class="flex items-center gap-1 font-medium text-foreground tabular-nums">
          <IconLucideTriangleAlert
            v-if="row.conflict"
            class="size-3 shrink-0 text-warning-text"
            :title="`port ${row.port} は複数プロセスが使用中`"
          />
          {{ row.port }}
        </span>
        <span class="truncate text-foreground-low" :title="`pid ${row.pid}`">{{ row.name }}</span>
        <span class="truncate text-foreground-low">
          <template v-if="row.worktreePath !== ''">
            <span class="text-foreground">{{ row.worktreeName }}</span>
            <span v-if="row.repoName !== ''" class="text-foreground-low">
              · {{ row.repoName }}</span
            >
          </template>
          <span v-else>—</span>
        </span>
        <span class="truncate text-right text-[10px]" :class="ATTRIBUTION_CLASS[row.attribution]">
          {{ ATTRIBUTION_LABEL[row.attribution] }}
        </span>
      </button>
    </div>
  </div>
</template>
