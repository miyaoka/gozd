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
import { computed, ref } from "vue";
import { formatCauseChain } from "./formatCause";

const props = defineProps<{
  type: "error" | "info";
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

const copyIconMap: Record<CopyState, string> = {
  idle: "icon-[lucide--copy]",
  copied: "icon-[lucide--check]",
  failed: "icon-[lucide--triangle-alert]",
};

const iconMap = {
  error: "icon-[lucide--circle-x]",
  info: "icon-[lucide--info]",
} as const;

const colorMap = {
  error: "border-destructive/60 bg-destructive/15",
  info: "border-border bg-background",
} as const;

const iconColorMap = {
  error: "text-destructive",
  info: "text-info",
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
      'pointer-events-auto flex w-md max-w-md flex-col rounded-lg border text-sm text-foreground-strong shadow-lg',
      colorMap[type],
    ]"
  >
    <div class="flex items-start gap-2 p-3">
      <span :class="['mt-0.5 size-4 shrink-0', iconMap[type], iconColorMap[type]]" />
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
          <span>{{ message }}</span>
          <span
            v-if="hasCause"
            :class="[
              'icon-[lucide--chevron-down] size-3 shrink-0 text-foreground-muted transition-transform',
              expanded ? 'rotate-180' : '',
            ]"
          />
        </span>
      </button>
      <button
        type="button"
        class="shrink-0 cursor-pointer text-foreground-muted hover:text-foreground-strong"
        aria-label="Dismiss"
        @click="$emit('dismiss')"
      >
        <span class="icon-[lucide--x] size-4" />
      </button>
    </div>
    <div v-if="hasCause && expanded" class="border-t border-accent p-3">
      <div class="mb-2 flex justify-end">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded-sm border border-border-strong px-2 py-0.5 text-xs text-foreground-strong hover:bg-accent-strong"
          @click="copyDetail"
        >
          <span :class="[copyIconMap[copyState], 'size-3']" />
          {{ copyLabelMap[copyState] }}
        </button>
      </div>
      <pre
        class="max-h-64 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-foreground-strong"
        >{{ detail }}</pre
      >
    </div>
  </div>
</template>
