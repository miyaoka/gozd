<doc lang="md">
diff の base 端を選ぶセグメントコントロール。

- **3 状態 (off / PR / Stack) を 1 個の群で表す**。独立したトグルを並べると Navigator の最小幅に
  ラベル付きボタンが 2 個入らない
- **mode ごとの分岐を持たない**。押せる mode は store が順序付きで返し、ここは mode をキーにした
  静的テーブルから表示語彙を引くだけ
- **セグメントが 1 個でも枠を出す**。stack の有無で枠が出入りすると同じ操作が別の見た目になる
- **幅で落とすのはラベルだけ**。操作はどの幅でも残し、PR 番号と stack 位置は title に置く。閾値は
  最近の container を見るため、ヘッダ側が `@container` を宣言している必要がある
- 選択中の面は `primary-subtle` (keyboard focus を持たない常設面の選択)。`element-active` は
  `primary-text` を載せると AA を割る
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import type { FunctionalComponent, SVGAttributes } from "vue";
import { computed } from "vue";
import type { PrDiffMode } from "../git-graph";
import { usePrDiffToggleStore } from "../git-graph";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";
import IconLucideLayers from "~icons/lucide/layers";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const prDiffToggle = usePrDiffToggleStore();

const MODE_TEXT: Record<
  PrDiffMode,
  {
    icon: FunctionalComponent<SVGAttributes>;
    label: string;
    /** title に出す比較対象。出典が mode ごとに違うため PR から引く */
    target: (pr: GitPullRequest) => string;
  }
> = {
  stack: {
    icon: IconLucideLayers,
    label: "Stack",
    // stack が `enabledModes` に入る条件が stack の base 端の解決なので、ここで stack は必ずある
    target: (pr) => `stack ${pr.stack?.position}/${pr.stack?.size}`,
  },
  pr: {
    icon: IconLucideGitPullRequest,
    label: "PR",
    target: (pr) => `PR #${pr.number}`,
  },
};

const segments = computed(() => {
  const pr = prDiffToggle.pr;
  // base 端が解決できている mode がある = PR がある。型の上でだけ undefined を潰す
  if (pr === undefined) return [];
  return prDiffToggle.enabledModes.map((mode) => {
    const text = MODE_TEXT[mode];
    return { mode, icon: text.icon, label: text.label, target: text.target(pr) };
  });
});

function title(segment: { mode: PrDiffMode; target: string }): string {
  if (prDiffToggle.enabling) return "Resolving diff base...";
  const verb = prDiffToggle.mode === segment.mode ? "Showing" : "Show";
  return `${verb} diff from ${segment.target} base to working tree (includes untracked)`;
}
</script>

<template>
  <div
    v-if="segments.length > 0"
    class="flex shrink-0 items-center divide-x divide-border-subtle overflow-hidden rounded-sm border border-border"
  >
    <button
      v-for="segment in segments"
      :key="segment.mode"
      type="button"
      class="flex items-center gap-1 px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors disabled:cursor-progress disabled:text-foreground-muted"
      :class="
        prDiffToggle.mode === segment.mode
          ? 'bg-primary-subtle text-primary-text hover:bg-primary-subtle-hover'
          : 'text-foreground-low hover:bg-element-hover hover:text-foreground'
      "
      :title="title(segment)"
      :disabled="prDiffToggle.enabling"
      :aria-busy="prDiffToggle.enabling"
      :aria-pressed="prDiffToggle.mode === segment.mode"
      :aria-label="`Toggle ${segment.label} diff`"
      @click="prDiffToggle.toggle(segment.mode)"
    >
      <IconLucideLoaderCircle v-if="prDiffToggle.enabling" class="size-3.5 shrink-0 animate-spin" />
      <component :is="segment.icon" v-else class="size-3.5 shrink-0" />
      <span class="hidden @min-[280px]:inline">{{ segment.label }}</span>
    </button>
  </div>
</template>
