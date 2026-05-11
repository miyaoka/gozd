<doc lang="md">
通知トーストの 1 アイテム。

## 動作

- `cause` がある場合のみメッセージ全体をクリック可能にし、詳細パネルを展開する
- `Error` インスタンスは `name + message + stack`、それ以外は `String(cause)` または `JSON.stringify` フォールバックで表示
- 詳細パネルには「Copy」ボタンを併設し、issue 報告にコピペしやすくする
- dismiss ボタンは独立しており、本文クリックで dismiss されない
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, ref } from "vue";

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
  error: "border-red-800 bg-red-950",
  info: "border-zinc-700 bg-zinc-900",
} as const;

const iconColorMap = {
  error: "text-red-400",
  info: "text-blue-400",
} as const;

const hasCause = computed(() => props.cause !== undefined);

// 循環参照や toString が壊れたオブジェクトでもトースト描画を壊さないように整形する
function safeStringify(value: unknown): string {
  // String() は Symbol.toPrimitive / toString / valueOf が壊れている時に throw する
  const stringResult = tryCatch(() => String(value));
  if (stringResult.ok && stringResult.value !== "[object Object]") {
    return stringResult.value;
  }
  // Object 系で String() が "[object Object]" になるケースは JSON 整形を試す
  const seen = new WeakSet<object>();
  const jsonResult = tryCatch(() =>
    JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      },
      2,
    ),
  );
  if (jsonResult.ok && jsonResult.value !== undefined) return jsonResult.value;
  // どちらも失敗 / undefined を返す場合は prototype-free な型表記にフォールバック。
  // Symbol.toStringTag の getter が throw するケースに備えてこれも tryCatch で包む
  const tagResult = tryCatch(() => Object.prototype.toString.call(value));
  return tagResult.ok ? tagResult.value : "[unrepresentable cause]";
}

const detail = computed(() => {
  const { cause } = props;
  if (cause instanceof Error) {
    const head = `${cause.name}: ${cause.message}`;
    const stack = cause.stack;
    if (stack === undefined || stack === "") return head;
    // V8 系の stack は先頭行に "name: message" を含み（message が改行を含めばその 1 行目のみ）、
    // WebKit/JavaScriptCore の stack はフレームのみで "name: message" 行を持たない。
    // stack.startsWith(head) で判定すると message が改行を含むときに V8 でも false になり二重表示になるため、
    // 先頭行が `<name>:` で始まるかで V8 形式と判定し、その場合は先頭行を捨てて head + 残り frame に正規化する。
    const [firstLine = "", ...rest] = stack.split("\n");
    const frames = firstLine.startsWith(`${cause.name}:`) ? rest : [firstLine, ...rest];
    const body = frames.join("\n");
    return body === "" ? head : `${head}\n${body}`;
  }
  if (typeof cause === "string") return cause;
  return safeStringify(cause);
});

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
          <span :class="[copyIconMap[copyState], 'size-3']" />
          {{ copyLabelMap[copyState] }}
        </button>
      </div>
      <pre
        class="max-h-64 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-zinc-200"
        >{{ detail }}</pre
      >
    </div>
  </div>
</template>
