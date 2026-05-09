<doc lang="md">
通知トーストの 1 アイテム。

## 動作

- `cause` がある場合のみメッセージ全体をクリック可能にし、詳細パネルを展開する
- `Error` インスタンスは `name + message + stack`、それ以外は `String(cause)` または `JSON.stringify` フォールバックで表示
- 詳細パネルには「Copy」ボタンを併設し、issue 報告にコピペしやすくする
- dismiss ボタンは独立しており、本文クリックで dismiss されない
</doc>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  type: "error" | "info";
  message: string;
  cause?: unknown;
}>();

defineEmits<{ dismiss: [] }>();

const expanded = ref(false);
const copied = ref(false);

const iconMap = {
  error: "icon-[lucide--circle-x]",
  info: "icon-[lucide--info]",
} as const;

const colorMap = {
  error: "border-red-800 bg-red-950",
  info: "border-zinc-700 bg-zinc-900",
} as const;

const iconColorMap = {
  error: "text-red-400",
  info: "text-blue-400",
} as const;

const hasCause = computed(() => props.cause !== undefined);

const detail = computed(() => {
  const { cause } = props;
  if (cause instanceof Error) {
    const head = `${cause.name}: ${cause.message}`;
    return cause.stack !== undefined && cause.stack !== "" ? cause.stack : head;
  }
  if (typeof cause === "string") return cause;
  const stringified = String(cause);
  if (stringified !== "[object Object]") return stringified;
  try {
    return JSON.stringify(cause, null, 2);
  } catch {
    return stringified;
  }
});

function toggle() {
  if (!hasCause.value) return;
  expanded.value = !expanded.value;
}

async function copyDetail() {
  const text = `${props.message}\n\n${detail.value}`;
  await navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

<template>
  <div
    :class="[
      'pointer-events-auto flex w-md max-w-md flex-col rounded-lg border text-sm text-white shadow-lg',
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
              'icon-[lucide--chevron-down] size-3 shrink-0 text-zinc-400 transition-transform',
              expanded ? 'rotate-180' : '',
            ]"
          />
        </span>
      </button>
      <button
        type="button"
        class="shrink-0 cursor-pointer text-zinc-400 hover:text-zinc-200"
        aria-label="Dismiss"
        @click="$emit('dismiss')"
      >
        <span class="icon-[lucide--x] size-4" />
      </button>
    </div>
    <div v-if="hasCause && expanded" class="border-t border-white/10 p-3">
      <div class="mb-2 flex justify-end">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded-sm border border-white/15 px-2 py-0.5 text-xs text-zinc-200 hover:bg-white/10"
          @click="copyDetail"
        >
          <span :class="[copied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]', 'size-3']" />
          {{ copied ? "Copied" : "Copy" }}
        </button>
      </div>
      <pre
        class="max-h-64 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-zinc-200"
        >{{ detail }}</pre
      >
    </div>
  </div>
</template>
