<doc lang="md">
ペイン境界のドラッグリサイズハンドル。掴んで動かした量だけ、両隣のペインのサイズを逆向きに
増減させる。水平・垂直のどちらの境界にも置ける。

**ドラッグの起点は、親が持つサイズの値ではなく実際に描かれているサイズから取れる**。親の持つ
値が「ユーザーが望んだサイズ」で、描画されているのがそれをウィンドウに収めた値である場合、
両者は食い違う。望んだ値を起点にすると、押し戻されている状態で掴んだ瞬間にペインがそちらへ
跳ねる。実測の取り方は親しか知らないため、取得手段そのものを親から受け取る。

隣り合うペインそれぞれに下限を持ち、下限に達した側はそれ以上譲らない。
</doc>

<script setup lang="ts">
import { useElementHover } from "@vueuse/core";
import { useTemplateRef } from "vue";
import { useResize } from "./useResize";

interface Props {
  direction: "horizontal" | "vertical";
  beforeMinSize: number;
  afterMinSize: number;
  getBeforeSize?: () => number;
  getAfterSize?: () => number;
}

const props = defineProps<Props>();
const beforeSize = defineModel<number>("beforeSize");
const afterSize = defineModel<number>("afterSize");

const handleRef = useTemplateRef<HTMLElement>("handle");
const isHovered = useElementHover(handleRef);

const { isDragging } = useResize(handleRef, beforeSize, afterSize, {
  direction: props.direction,
  get beforeMinSize() {
    return props.beforeMinSize;
  },
  get afterMinSize() {
    return props.afterMinSize;
  },
  getBeforeSize: props.getBeforeSize,
  getAfterSize: props.getAfterSize,
});
</script>

<template>
  <div
    ref="handle"
    class="z-10 flex shrink-0 items-center justify-center"
    :class="direction === 'horizontal' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'"
  >
    <div
      class="pointer-events-none transition-colors duration-150"
      :class="[
        direction === 'horizontal' ? 'h-full w-px' : 'h-px w-full',
        isDragging || isHovered ? 'bg-primary' : 'bg-element',
      ]"
    />
  </div>
</template>
