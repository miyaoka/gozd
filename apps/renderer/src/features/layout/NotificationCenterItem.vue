<doc lang="md">
Notification center の 1 行。toast (NotificationToastItem) と同じ通知を表示するが、
一覧の中の行として時刻・累計回数を持ち、dismiss ではなく center からの削除を emit する。

## 動作

- 詳細 (cause) を 1 件でも持つ通知のみ行頭に disclosure ボタン (閉 = ►、開 = ▼。DevTools と
  同じ文法) を出し、**発生履歴 (occurrences) を発生ごとに時刻 + cause chain で**その字下げ
  配下に展開する。同一 message の集約 (issue) と個々の発生 (event) を分けて見せる
  Sentry 型の二層モデルで、集約によって発生時刻・詳細差分が失われない。
  開閉ターゲットは 24px (WCAG 2.5.8 の最小ターゲットサイズ)。本文は選択可能なテキストで、
  click toggle と select-text を同一要素に同居させない
- toast の Details ボタンから遷移した項目 (store の `revealId`) は mount / 変更時に
  自動展開して可視位置へスクロールする
- 詳細パネルには Copy ボタンを併設し、message + 全発生 (時刻つき) をクリップボードへコピーする
- `count` が 2 以上なら累計発生回数チップを出す（重複抑制で 1 項目に集約されるため）。
  count は occurrences の保持上限を超えても加算されるため、履歴は直近分のみのことがある
</doc>

<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  useTemplateRef,
  watch,
  type FunctionalComponent,
  type SVGAttributes,
} from "vue";
import { writeClipboardText } from "../../shared/clipboard";
import { hasNotificationDetails, type Notification } from "../../shared/notification";
import { formatCauseChain } from "./formatCause";
import { useNotificationCenterStore } from "./useNotificationCenterStore";
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

const hasDetails = computed(() => hasNotificationDetails(props.notification));

/** 発生ごとの表示行 (新しい順)。cause の無い発生は時刻のみの行になる */
const occurrenceRows = computed(() =>
  props.notification.occurrences.map((o) => ({
    time: formatTime(o.at),
    detail: o.cause !== undefined ? formatCauseChain(o.cause) : "",
  })),
);

/** epoch ms → HH:MM:SS。center は同日運用が主なので日付は出さない。 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const time = computed(() => formatTime(props.notification.at));

const centerStore = useNotificationCenterStore();
const rootRef = useTemplateRef<HTMLElement>("root");

// toast の Details から遷移してきた項目を自動展開して可視位置へ出す。
// immediate は「reveal → open → item mount」の順で mount 時に revealId が既に立っている
// ケース (center が閉じていた場合) を拾うため
watch(
  () => centerStore.revealId,
  async (id) => {
    if (id !== props.notification.id) return;
    // 詳細なし通知への reveal 要求は消費だけして展開しない (空の詳細パネルを出さない)。
    // 現状の呼び出し元 (toast の Details) は詳細有無をガード済みだが、単体でも成立させる
    if (!hasDetails.value) {
      centerStore.clearReveal();
      return;
    }
    expanded.value = true;
    centerStore.clearReveal();
    await nextTick();
    rootRef.value?.scrollIntoView({ block: "nearest" });
  },
  { immediate: true },
);

async function copyDetail() {
  const body = occurrenceRows.value
    .map((row) => (row.detail === "" ? row.time : `[${row.time}]\n${row.detail}`))
    .join("\n\n");
  const text = `${props.notification.message}\n\n${body}`;
  const result = await writeClipboardText(text);
  copyState.value = result.ok ? "copied" : "failed";
  setTimeout(() => {
    copyState.value = "idle";
  }, COPY_FEEDBACK_MS);
}
</script>

<template>
  <div ref="root" class="flex flex-col border-b border-border-subtle">
    <div class="flex items-start gap-1 p-2">
      <!-- DevTools の disclosure 文法: 三角形は行頭に置き、閉 = ►、開 = ▼。
           詳細はこの列より右 (字下げ配下) に展開され、親行への帰属が構造で読める -->
      <button
        v-if="hasDetails"
        type="button"
        class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Hide details' : 'Show details'"
        :title="expanded ? 'Hide details' : 'Show details'"
        @click="expanded = !expanded"
      >
        <IconLucideChevronDown
          class="size-4 transition-transform"
          :class="expanded ? '' : '-rotate-90'"
        />
      </button>
      <!-- 詳細なし項目の桁揃え用スペーサー -->
      <span v-else class="size-6 shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex items-start gap-2">
          <component
            :is="iconMap[notification.type]"
            :class="['mt-1 size-4 shrink-0', iconColorMap[notification.type]]"
          />
          <p class="min-w-0 flex-1 py-0.5 text-sm break-all text-foreground select-text">
            {{ notification.message }}
          </p>
        </div>
        <div class="flex items-center gap-2 text-[11px] text-foreground-low">
          <span class="tabular-nums">{{ time }}</span>
          <span
            v-if="notification.count > 1"
            class="rounded-sm bg-element px-1 font-semibold tabular-nums"
          >
            ×{{ notification.count }}
          </span>
        </div>
        <div v-if="hasDetails && expanded" class="flex items-start gap-2">
          <div class="flex max-h-64 min-w-0 flex-1 flex-col gap-2 overflow-auto">
            <div v-for="(row, i) in occurrenceRows" :key="i" class="flex flex-col">
              <span class="text-[11px] text-foreground-low tabular-nums select-text">
                {{ row.time }}
              </span>
              <pre
                v-if="row.detail !== ''"
                class="font-mono text-xs break-all whitespace-pre-wrap text-foreground select-text"
                >{{ row.detail }}</pre>
            </div>
          </div>
          <button
            type="button"
            class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
            :aria-label="copyLabelMap[copyState]"
            :title="copyLabelMap[copyState]"
            @click="copyDetail"
          >
            <component :is="copyIconMap[copyState]" class="size-4" />
          </button>
        </div>
      </div>
      <button
        type="button"
        class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        aria-label="Remove notification"
        @click="$emit('remove')"
      >
        <IconLucideX class="size-4" />
      </button>
    </div>
  </div>
</template>
