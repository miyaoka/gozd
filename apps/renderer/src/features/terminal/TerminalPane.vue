<doc lang="md">
ターミナルペイン。worktree ごとの分割ツリーをフラットにレンダリングする。

## レイアウト方式

再帰コンポーネントではなく、flattenTree() でツリーを走査し全 leaf / handle の
絶対位置（px）を算出。v-for + position: absolute でフラットに配置する。
ツリー構造が変わっても既存 leaf の key(id) が同じなので Vue がコンポーネントを
再利用し、xterm インスタンスと PTY のリマウントが起きない。

## leaf の存在と rect の分離

- leaf の存在: ツリー構造（collectLeafIds）で決まる。split/close でのみ変化
- leaf の rect: コンテナサイズ（flattenTree）で決まる。v-show:false で 0x0 になっても前回値を維持
</doc>

<script setup lang="ts">
import { useElementSize } from "@vueuse/core";
import { computed, ref, shallowRef, watchEffect } from "vue";
import { useWorkspaceStore } from "../filer";
import SplitResizeHandle from "./SplitResizeHandle.vue";
import type { FlatElement, FlatHandle, PixelRect } from "./splitTree";
import { collectLeafIds, flattenTree } from "./splitTree";
import TerminalLeaf from "./TerminalLeaf.vue";
import { useTerminalStore } from "./useTerminalStore";

/**
 * 文字列から簡易ハッシュ値を生成する（djb2）。
 * 色生成用なので暗号学的な強度は不要。
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

/** ハッシュ値からパステル HSL 色を生成。hueOffset で類似色をずらす。各成分は異なるビット領域から取得 */
function hashToColor(hash: number, hueOffset = 0): string {
  const hue = ((hash % 360) + hueOffset) % 360;
  const saturation = 20 + ((hash >>> 12) % 15); // 20-34%
  const lightness = 60 + ((hash >>> 24) % 25); // 60-84%
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

const props = defineProps<{
  dir: string;
}>();

const terminalStore = useTerminalStore();
const workspaceStore = useWorkspaceStore();
const layout = computed(() => terminalStore.ensureLayout(props.dir));

const HUE_OFFSET = 30;

const paneBackground = computed(() => {
  const name = workspaceStore.repoName ?? "gozd";
  const hash = hashString(name);
  const color1 = hashToColor(hash);
  const color2 = hashToColor(hash, HUE_OFFSET);
  return `linear-gradient(0deg, ${color1} 0%, ${color2} 100%)`;
});

// leaf の存在はツリー構造で決まる（split/close でのみ変化）
const leafIds = computed(() => collectLeafIds(layout.value.root));

const containerRef = ref<HTMLElement>();
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef);

// leaf の位置・サイズはコンテナサイズで決まる（リサイズ時に更新）
// v-show:false でサイズが 0 になっても前回の結果を維持し、leaf の unmount を防ぐ
const hasMeasuredOnce = ref(false);
const flatElements = shallowRef<FlatElement[]>([]);

watchEffect(() => {
  if (containerWidth.value <= 0 || containerHeight.value <= 0) return;
  hasMeasuredOnce.value = true;
  flatElements.value = flattenTree(layout.value.root, containerWidth.value, containerHeight.value);
});

const rectByLeafId = computed(() => {
  const map = new Map<string, PixelRect>();
  for (const el of flatElements.value) {
    if (el.type === "leaf") map.set(el.id, el.rect);
  }
  return map;
});

const flatHandles = computed(() =>
  flatElements.value.filter((el): el is FlatHandle => el.type === "handle"),
);

function rectStyle(rect: PixelRect | undefined) {
  if (rect === undefined) return { position: "absolute" as const };
  return {
    position: "absolute" as const,
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}
</script>

<template>
  <div class="size-full overflow-hidden p-2.5" :style="{ background: paneBackground }">
    <div ref="containerRef" class="relative size-full">
      <template v-if="hasMeasuredOnce">
        <TerminalLeaf
          v-for="id in leafIds"
          :key="id"
          :dir="dir"
          :leaf-id="id"
          :style="rectStyle(rectByLeafId.get(id))"
        />
      </template>

      <SplitResizeHandle
        v-for="handle in flatHandles"
        :key="handle.branchId"
        :dir="dir"
        :branch-id="handle.branchId"
        :axis="handle.axis"
        :ratio="handle.ratio"
        :first-node="handle.firstNode"
        :second-node="handle.secondNode"
        :available-px="handle.availablePx"
        :style="rectStyle(handle.rect)"
      />
    </div>
  </div>
</template>
