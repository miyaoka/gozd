<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed, useTemplateRef } from "vue";
import { pathBaseName, useRepoStore } from "../../shared/repo";
import { useSurface } from "../../shared/surface";
import { activateDir, useTerminalStore } from "../terminal";
import { WorktreeLabel } from "../worktree";
import type { ServerAttributionKind } from "./rpc";
import { useServerStore } from "./useServerStore";
import IconLucideServer from "~icons/lucide/server";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideX from "~icons/lucide/x";

const serverStore = useServerStore();
const repoStore = useRepoStore();
const terminalStore = useTerminalStore();

interface ServerRow {
  key: string;
  port: number;
  pid: number;
  name: string;
  attribution: ServerAttributionKind;
  worktreePath: string;
  ptyId: number;
  repoName: string;
  /** 解決できた worktree。行クリックで開けるのはこれがあるときだけ */
  worktree: WorktreeEntry | undefined;
  conflict: boolean;
}

/**
 * worktree path → 表示用の repo 名 + worktree。`findRepoOwning` で worktree が解決できない
 * (external で空 / orphaned で worktree 削除済み) 場合は worktree を持たせず、存在しない dir を
 * `setOpen` する壊れた選択状態を防ぐ。
 */
function resolveNames(worktreePath: string): {
  repoName: string;
  worktree: WorktreeEntry | undefined;
} {
  if (worktreePath === "") return { repoName: "", worktree: undefined };
  const repo = repoStore.findRepoOwning(worktreePath);
  const worktree = repo?.worktrees.find((w) => w.path === worktreePath);
  return { repoName: repo?.repoName ?? "", worktree };
}

const ATTRIBUTION_LABEL: Record<ServerAttributionKind, string> = {
  live: "live",
  orphaned: "closed",
  external: "external",
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
      worktree: names.worktree,
      conflict: false,
    }));
  });

  const portCounts = new Map<number, number>();
  for (const row of flat) portCounts.set(row.port, (portCounts.get(row.port) ?? 0) + 1);
  for (const row of flat) row.conflict = (portCounts.get(row.port) ?? 0) > 1;

  return flat.sort((a, b) => (a.port !== b.port ? a.port - b.port : a.pid - b.pid));
});

function onRowClick(row: ServerRow): void {
  // worktree が解決できない行 (external / 削除済み orphaned) は開けない。
  if (row.worktree === undefined) return;
  activateDir(row.worktreePath);
  // live なら該当端末ペインへフォーカスする (ptyId は帰属先 PTY)。
  // focusPaneByPtyId には寄せない: この ptyId は main のポーリング snapshot 由来で、
  // pane close 後も最大 1 スキャン分 stale に残る。解決失敗は不整合ではなく正常系なので
  // silent skip が正しい (worktree の選択自体は成立しておりクリックは無反応にならない)。
  if (row.ptyId > 0) {
    const leafId = terminalStore.getLeafIdByPtyId(row.ptyId);
    if (leafId !== undefined) terminalStore.focusPane(leafId);
  }
  serverStore.close();
}

const panelRef = useTemplateRef<HTMLElement>("panel");

const { raise } = useSurface(panelRef, {
  isOpen: () => serverStore.isOpen,
  requestClose: () => serverStore.close(),
});
</script>

<template>
  <div
    ref="panel"
    popover="manual"
    tabindex="-1"
    class="_server-list-popover w-[480px] flex-col border-0 border-l border-border bg-panel p-0 shadow-xl outline-hidden [&:popover-open]:flex"
    @pointerdown.capture="raise()"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideServer class="size-4 text-foreground-low" />
      <h2 class="flex-1 text-sm font-medium text-foreground">Running servers</h2>
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
      No listening TCP servers detected
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <!-- header row -->
      <div
        class="sticky top-0 grid grid-cols-[64px_1fr_1.4fr_72px] gap-2 border-b border-border bg-panel px-3 py-1.5 text-[10px] font-medium tracking-wide text-foreground-low uppercase"
      >
        <span>Port</span>
        <span>Process</span>
        <span>repo / worktree</span>
        <span class="text-right">Kind</span>
      </div>
      <button
        v-for="row in rows"
        :key="row.key"
        type="button"
        :disabled="row.worktree === undefined"
        class="grid w-full grid-cols-[64px_1fr_1.4fr_72px] items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors not-disabled:cursor-pointer not-disabled:hover:bg-element-hover disabled:cursor-default"
        @click="onRowClick(row)"
      >
        <span class="flex items-center gap-1 font-medium text-foreground tabular-nums">
          <IconLucideTriangleAlert
            v-if="row.conflict"
            class="size-3 shrink-0 text-warning-text"
            :title="`Port ${row.port} is used by multiple processes`"
          />
          {{ row.port }}
        </span>
        <span class="truncate text-foreground-low" :title="`pid ${row.pid}`">{{ row.name }}</span>
        <!-- 狭いときは repo 名から切り、worktree 名を残す -->
        <span class="flex min-w-0 items-center gap-1 overflow-hidden text-foreground-low">
          <template v-if="row.worktreePath !== ''">
            <span class="max-w-full shrink-0 text-foreground">
              <WorktreeLabel v-if="row.worktree" :wt="row.worktree" />
              <span v-else class="block truncate">{{ pathBaseName(row.worktreePath) }}</span>
            </span>
            <span v-if="row.repoName !== ''" class="min-w-0 truncate text-foreground-low"
              >· {{ row.repoName }}</span
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

<style>
._server-list-popover {
  /* タイトルバー（drag 領域）を覆わないよう、上端をその直下に置き右端に沿わせる */
  inset: unset;
  margin: 0;
  top: var(--titlebar-height);
  right: 0;
  bottom: 0;
  /* UA スタイル [popover] { height: fit-content } を打ち消す。
     height が auto でないと top + bottom の伸縮が効かずコンテンツ高さに縮む */
  height: auto;
  max-height: none;
  /* UA スタイル [popover] { overflow: auto } を打ち消す。スクロールするのは中身の一覧だけで、
     パネルそのものは動かない。残すとパネル全体が縦スクロールし、ヘッダーが画面外へ流れる */
  overflow: hidden;
}
</style>
