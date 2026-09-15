<doc lang="md">
セッションプレビュー (TerminalSessionPreview) の 1 run (同じ話者の連続発言) を描く。どの行をどの順に
出すかは `runRows` (`terminalSessionPreviewMessages.ts`) が決め、ここは開閉状態と、開いた発言を
トグルのどちら側に出すか (`revealSide`) を受け取って描くだけで状態を持たない。どちら側に出すかと、
押したトグルをポインタの下に留めるスクロール補正は、overlay の配置を知る親が決める。
</doc>

<script setup lang="ts">
import { computed, type FunctionalComponent, type SVGAttributes } from "vue";
import { SessionLogSpeechText, SPEAKER_SURFACE_CLASS, type Speech } from "../session-log";
import { type PreviewRun, type RevealSide, runRows } from "./terminalSessionPreviewMessages";
import TerminalSessionPreviewSpeakerRow from "./TerminalSessionPreviewSpeakerRow.vue";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideChevronRight from "~icons/lucide/chevron-right";
import IconLucideChevronUp from "~icons/lucide/chevron-up";

interface Props {
  run: PreviewRun;
  expanded: boolean;
  revealSide: RevealSide;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  toggle: [anchor: HTMLElement];
  select: [anchor: HTMLElement, speech: Speech];
}>();

// 開いたトグルのアイコンは、開いた発言が出る側を指す
const EXPANDED_ICON: Record<RevealSide, FunctionalComponent<SVGAttributes>> = {
  above: IconLucideChevronUp,
  below: IconLucideChevronDown,
};

const rows = computed(() => runRows(props.run, props.expanded, props.revealSide));
const toggleIcon = computed(() =>
  props.expanded ? EXPANDED_ICON[props.revealSide] : IconLucideChevronRight,
);

function toggleLabel(foldableCount: number): string {
  return props.expanded ? "Show less" : `${foldableCount} more`;
}

function buttonOf(event: MouseEvent): HTMLElement {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) throw new Error("click target is not an element");
  return button;
}

function onToggle(event: MouseEvent) {
  emit("toggle", buttonOf(event));
}

function onSelect(event: MouseEvent, speech: Speech) {
  emit("select", buttonOf(event), speech);
}
</script>

<template>
  <!-- key: トグルは開閉をまたいで同じ要素を保つ (親が開閉前後の位置を測る)。発言は発言列全体での
       位置で、ログ追記や開閉で同じ発言の DOM を作り替えない -->
  <TerminalSessionPreviewSpeakerRow
    v-for="row in rows"
    :key="row.kind === 'toggle' ? 'toggle' : row.index"
    :speaker="run.speaker"
  >
    <button
      v-if="row.kind === 'toggle'"
      type="button"
      class="flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-foreground-low hover:bg-element-hover"
      :aria-expanded="expanded"
      @click="onToggle"
    >
      <component :is="toggleIcon" class="size-3" />
      {{ toggleLabel(row.foldableCount) }}
    </button>
    <button
      v-else
      type="button"
      class="block max-w-[85%] cursor-pointer rounded-lg px-2 py-1 text-left hover:brightness-110"
      :class="SPEAKER_SURFACE_CLASS[run.speaker]"
      :title="row.speech.text"
      @click="onSelect($event, row.speech)"
    >
      <SessionLogSpeechText class="line-clamp-2" :text="row.speech.text" :mark="row.speech.mark" />
    </button>
  </TerminalSessionPreviewSpeakerRow>
</template>
