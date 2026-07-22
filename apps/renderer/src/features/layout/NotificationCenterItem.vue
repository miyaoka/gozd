<doc lang="md">
Notification center の 1 行。toast (NotificationToastItem) と同じ通知を表示するが、
一覧の中の行として時刻・累計回数を持ち、dismiss ではなく center からの削除を emit する。

## 動作

- `cause` がある場合のみメッセージをクリック可能にし、詳細（cause chain）を展開する
- 詳細パネルには Copy ボタンを併設し、message + 詳細をクリップボードへコピーする
- `count` が 2 以上なら累計発生回数チップを出す（重複抑制で 1 項目に集約されるため）
</doc>

<script setup lang="ts">
import { computed, ref, type FunctionalComponent, type SVGAttributes } from "vue";
import { writeClipboardText } from "../../shared/clipboard";
import type { Notification } from "../../shared/notification";
import { formatCauseChain } from "./formatCause";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideCircleX from "~icons/lucide/circle-x";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideInfo from "~icons/lucide/info";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{ notification: Notification }>();

defineEmits<{ remove: [] }>();

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

const iconMap: Record<Notification["type"], FunctionalComponent<SVGAttributes>> = {
  error: IconLucideCircleX,
  warning: IconLucideTriangleAlert,
  info: IconLucideInfo,
};

const iconColorMap: Record<Notification["type"], string> = {
  error: "text-destructive-text",
  warning: "text-warning-text",
  info: "text-primary-text",
};

const hasCause = computed(() => props.notification.cause !== undefined);

const detail = computed(() => formatCauseChain(props.notification.cause));

/** epoch ms → HH:MM:SS。center は同日運用が主なので日付は出さない。 */
const time = computed(() => {
  const d = new Date(props.notification.at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});

function toggle() {
  if (!hasCause.value) return;
  expanded.value = !expanded.value;
}

async function copyDetail() {
  const text = `${props.notification.message}\n\n${detail.value}`;
  const result = await writeClipboardText(text);
  copyState.value = result.ok ? "copied" : "failed";
  setTimeout(() => {
    copyState.value = "idle";
  }, COPY_FEEDBACK_MS);
}
</script>

<template>
  <div class="flex flex-col border-b border-border-subtle">
    <div class="flex items-start gap-2 px-3 py-2">
      <component
        :is="iconMap[notification.type]"
        :class="['mt-0.5 size-4 shrink-0', iconColorMap[notification.type]]"
      />
      <div class="min-w-0 flex-1">
        <button
          type="button"
          :class="[
            'w-full text-left text-sm break-all text-foreground',
            hasCause ? 'cursor-pointer hover:underline' : 'cursor-default',
          ]"
          :aria-expanded="hasCause ? expanded : undefined"
          :disabled="!hasCause"
          :title="hasCause ? (expanded ? 'Hide details' : 'Show details') : undefined"
          @click="toggle"
        >
          <span class="flex items-center gap-1">
            <span :class="hasCause ? '' : 'select-text'">{{ notification.message }}</span>
            <IconLucideChevronDown
              v-if="hasCause"
              class="size-3 shrink-0 text-foreground-low transition-transform"
              :class="expanded ? 'rotate-180' : ''"
            />
          </span>
        </button>
        <div class="flex items-center gap-2 text-[11px] text-foreground-low">
          <span class="tabular-nums">{{ time }}</span>
          <span
            v-if="notification.count > 1"
            class="rounded-sm bg-element px-1 font-semibold tabular-nums"
          >
            ×{{ notification.count }}
          </span>
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 cursor-pointer text-foreground-low hover:text-foreground"
        aria-label="Remove notification"
        @click="$emit('remove')"
      >
        <IconLucideX class="size-4" />
      </button>
    </div>
    <div v-if="hasCause && expanded" class="border-t border-border-subtle px-3 py-2">
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
        >{{ detail }}</pre>
    </div>
  </div>
</template>
