<doc lang="md">
実行中サーバー (TCP LISTEN プロセス) の一覧パネル。

TitleBar の renderer ボタン → `useServerStore.toggle()` で開閉する
右ドック型オーバーレイ。port 競合調査が主目的なので、各サーバーを **port 単位の行**に展開して
port 昇順で並べ、同一 port が複数プロセスに跨るときは衝突候補として警告色で示す。

行クリックで該当サーバーの worktree を active にし、live なら端末ペインへフォーカスする。
gozd 外 (external) と、帰属先 worktree が既に削除済みの orphaned はクリック不可
(`findRepoOwning` で解決できる行だけ開ける)。

ドック型 (背景を覆わない) にしているのは、ターミナルを見ながら port の主を調べる用途のため。
ESC / Cmd+W か閉じるボタンで閉じる。

他のドックパネル / undock パネルと並ぶ top layer のサーフェス 1 枚 (`shared/surface`)。開閉の
SSOT は store の `isOpen` で、popover DOM へのミラーは要素を所有する本 component が担う
(store は DOM を持たない)。`useSurface` で前面化と close の宛先も登録する。重ね順は
click-to-front、ESC / Cmd+W はフォーカスがあるサーフェスを閉じる。
</doc>

<script setup lang="ts">
import { computed, useTemplateRef } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useSurface } from "../../shared/surface";
import { activateDir, useTerminalStore } from "../terminal";
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
  worktreeName: string;
  /** 行クリックで worktree を開けるか。worktree が解決できる場合のみ true。 */
  openable: boolean;
  conflict: boolean;
}

/**
 * worktree path → 表示用の repo 名 / worktree 名 + 開けるか。`findRepoOwning` で worktree が
 * 解決できない (external で空 / orphaned で worktree 削除済み) 場合は openable=false にし、
 * 存在しない dir を `setOpen` する壊れた選択状態を防ぐ。
 */
function resolveNames(worktreePath: string): {
  repoName: string;
  worktreeName: string;
  openable: boolean;
} {
  if (worktreePath === "") return { repoName: "", worktreeName: "", openable: false };
  const repo = repoStore.findRepoOwning(worktreePath);
  const wt = repo?.worktrees.find((w) => w.path === worktreePath);
  const branch = wt?.branch ?? "";
  const worktreeName =
    branch !== "" ? branch.replace(/^refs\/heads\//, "") : basename(worktreePath);
  return { repoName: repo?.repoName ?? "", worktreeName, openable: wt !== undefined };
}

function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  const [last = path] = parts.slice(-1);
  return last;
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
      worktreeName: names.worktreeName,
      openable: names.openable,
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
  if (!row.openable) return;
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
        :disabled="!row.openable"
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
}
</style>
