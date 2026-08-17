<doc lang="md">
diff の base 端を選ぶセグメントコントロール。

## 3 状態を 1 個の群で表す

base 端は PR base / stack base のどちらか一方だけが有効で、両方 off も含めて 3 状態から 1 つを
選ぶ選択になる。独立したトグルを 2 個並べると、状態空間に対して表現が冗長なうえ幅も 2 倍要る。
Navigator の最小幅は 180px しかなく、ラベル付きボタン 2 個は入らない。

## 幅で落とすのはラベルだけ

container query で狭いときラベルを畳み、アイコンだけにする。操作はどの幅でも全部残す。PR 番号と
stack 位置は title に置く。閾値は最近の container を見るため、ヘッダ側が `@container` を宣言して
いる必要がある。閾値の根拠 (段ごとの必要幅) は ChangesPane の `<doc>` が持つ。

## stack が無いときも枠を出す

PR しか選べない場合もセグメント 1 個として枠の中に描く。stack の有無で枠が出たり消えたりすると、
同じ操作が別の見た目で現れることになる。

## 選択面は active row の語彙

選択中は keyboard focus を持たない常設面の選択なので `primary-subtle` (+ hover 変種) を使う。
`selection` は focused list のカーソル行の role で、ここではない。`element-active` (gray-5) は
`primary-text` を載せると 4.38:1 で AA を割るため使えない。
</doc>

<script setup lang="ts">
import type { FunctionalComponent, SVGAttributes } from "vue";
import { computed } from "vue";
import type { PrDiffMode } from "../git-graph";
import { usePrDiffToggleStore } from "../git-graph";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";
import IconLucideLayers from "~icons/lucide/layers";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

const prDiffToggle = usePrDiffToggleStore();

interface Segment {
  mode: PrDiffMode;
  icon: FunctionalComponent<SVGAttributes>;
  label: string;
  /** title に出す比較対象。狭い幅ではラベルが畳まれるので、識別子はここだけが持つ */
  target: string;
}

/** 押せる mode だけを trunk に近い順で並べる。押せない mode は枠から外す。 */
const segments = computed<Segment[]>(() => {
  const list: Segment[] = [];
  const stack = prDiffToggle.stack;
  if (prDiffToggle.canEnableStack && stack !== undefined) {
    list.push({
      mode: "stack",
      icon: IconLucideLayers,
      label: "Stack",
      target: `stack ${stack.position}/${stack.size}`,
    });
  }
  if (prDiffToggle.canEnable) {
    list.push({
      mode: "pr",
      icon: IconLucideGitPullRequest,
      label: "PR",
      target: `PR #${prDiffToggle.pr?.number}`,
    });
  }
  return list;
});

function title(segment: Segment): string {
  if (prDiffToggle.enabling) return "Resolving diff base...";
  const verb = prDiffToggle.mode === segment.mode ? "Showing" : "Show";
  return `${verb} diff from ${segment.target} base to working tree (includes untracked)`;
}
</script>

<template>
  <div
    v-if="segments.length > 0"
    class="flex shrink-0 items-center divide-x divide-border overflow-hidden rounded-sm border border-border"
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
      @click="prDiffToggle.toggle(segment.mode)"
    >
      <IconLucideLoaderCircle v-if="prDiffToggle.enabling" class="size-3.5 shrink-0 animate-spin" />
      <component :is="segment.icon" v-else class="size-3.5 shrink-0" />
      <span class="hidden @min-[280px]:inline">{{ segment.label }}</span>
    </button>
  </div>
</template>
