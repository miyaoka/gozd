<doc lang="md">
通知トーストの 1 アイテム。

## 動作

- `cause` がある場合のみメッセージ全体をクリック可能にし、詳細パネルを展開する
- `Error` の `cause` chain を再帰的に辿り、各段を `Caused by: ` で連結して表示する
- `Error` 以外（string / object など）は 1 段だけ整形して終了
- 詳細パネルには「Copy」ボタンを併設し、issue 報告にコピペしやすくする
- dismiss ボタンは独立しており、本文クリックで dismiss されない
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, ref, type FunctionalComponent, type SVGAttributes } from "vue";
import { formatCauseChain } from "./formatCause";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideCircleX from "~icons/lucide/circle-x";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideInfo from "~icons/lucide/info";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  type: "error" | "warning" | "info";
  message: string;
  cause?: unknown;
}>();

defineEmits<{ dismiss: [] }>();

type CopyState = "idle" | "copied" | "failed";

const expanded = ref(false);
const copyState = ref<CopyState>("idle");

const COPY_FEEDBACK_MS = 1500;

const copyLabelMap: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Failed",
};

const copyIconMap: Record<CopyState, FunctionalComponent<SVGAttributes>> = {
  idle: IconLucideCopy,
  copied: IconLucideCheck,
  failed: IconLucideTriangleAlert,
};

const iconMap = {
  error: IconLucideCircleX,
  warning: IconLucideTriangleAlert,
  info: IconLucideInfo,
} as const;

const colorMap = {
  error: "border-destructive bg-destructive-subtle",
  warning: "border-warning bg-warning-subtle",
  info: "border-border bg-background",
} as const;

const iconColorMap = {
  error: "text-destructive-text",
  warning: "text-warning-text",
  info: "text-primary-text",
} as const;

const hasCause = computed(() => props.cause !== undefined);

const detail = computed(() => formatCauseChain(props.cause));

function toggle() {
  if (!hasCause.value) return;
  expanded.value = !expanded.value;
}

async function copyDetail() {
  const text = `${props.message}\n\n${detail.value}`;
  // navigator.clipboard 自体が undefined の環境（古い WebView / 非 secure context）で
  // .writeText 参照時点の同期 throw も拾うため、async IIFE で Promise 化してから tryCatch に渡す。
  // tryCatch の関数版は Result<Promise<T>> を返すだけで Promise の reject を拾わないため、
  // ここでは Promise 版に流し込む必要がある。
  const result = await tryCatch((async () => navigator.clipboard.writeText(text))());
  copyState.value = result.ok ? "copied" : "failed";
  setTimeout(() => {
    copyState.value = "idle";
  }, COPY_FEEDBACK_MS);
}
</script>

<template>
  <div
    :class="[
      'pointer-events-auto flex w-md max-w-md flex-col rounded-lg border text-sm text-foreground shadow-lg',
      colorMap[type],
    ]"
  >
    <div class="flex items-start gap-2 p-3">
      <component :is="iconMap[type]" :class="['mt-0.5 size-4 shrink-0', iconColorMap[type]]" />
      <button
        type="button"
        :class="[
          'min-w-0 flex-1 text-left break-all',
          hasCause ? 'cursor-pointer hover:underline' : 'cursor-default',
        ]"
        :aria-expanded="hasCause ? expanded : undefined"
        :disabled="!hasCause"
        :title="hasCause ? (expanded ? 'Hide details' : 'Show details') : undefined"
        @click="toggle"
      >
        <span class="flex items-center gap-1">
          <!-- エラー本文はコピー対象。cause がある通知は本 button が toggle するため
               select-text を同居させず、Copy ボタン (message + detail) をコピー導線にする。
               cause が無い通知は button が disabled で click しないので、Copy ボタンも出ない
               本文を select-text で選択可にしても toggle が暴発しない (select-text と click を
               同一要素に同居させない)。 -->
          <span :class="hasCause ? '' : 'select-text'">{{ message }}</span>
          <IconLucideChevronDown
            v-if="hasCause"
            class="size-3 shrink-0 text-foreground-low transition-transform"
            :class="expanded ? 'rotate-180' : ''"
          />
        </span>
      </button>
      <button
        type="button"
        class="shrink-0 cursor-pointer text-foreground-low hover:text-foreground"
        aria-label="Dismiss"
        @click="$emit('dismiss')"
      >
        <IconLucideX class="size-4" />
      </button>
    </div>
    <div v-if="hasCause && expanded" class="border-t border-border-subtle p-3">
      <div class="mb-2 flex justify-end">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded-sm border border-border-subtle px-2 py-0.5 text-xs text-foreground hover:bg-element-hover"
          @click="copyDetail"
        >
          <component :is="copyIconMap[copyState]" class="size-3" />
          {{ copyLabelMap[copyState] }}
        </button>
      </div>
      <pre
        class="max-h-64 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-foreground select-text"
        >{{ detail }}</pre
      >
    </div>
  </div>
</template>
