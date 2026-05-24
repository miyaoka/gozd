<doc lang="md">
VOICEVOX のキャラとスタイルを 2 段 select で選ぶコンポーネント。
キャラを変更したら、そのキャラの先頭 style の id に切り替える。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { useVoicevoxStore } from "../voicevox";

const voicevoxStore = useVoicevoxStore();

const currentSpeaker = computed(() =>
  voicevoxStore.speakers.find((s) =>
    s.styles.some((style) => style.id === voicevoxStore.speakerId),
  ),
);

const currentStyles = computed(() => currentSpeaker.value?.styles ?? []);

function handleSpeakerChange(event: Event) {
  const speakerName = (event.target as HTMLSelectElement).value;
  const speaker = voicevoxStore.speakers.find((s) => s.name === speakerName);
  const firstStyleId = speaker?.styles[0]?.id;
  if (firstStyleId !== undefined) {
    voicevoxStore.speakerId = firstStyleId;
  }
}

function handleStyleChange(event: Event) {
  voicevoxStore.speakerId = Number((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div v-if="voicevoxStore.speakers.length > 0" class="flex flex-col gap-1">
    <div class="flex items-center gap-2 text-xs text-zinc-500">
      <span class="icon-[lucide--user] size-4 shrink-0" title="Character" />
      <select
        aria-label="VOICEVOX character"
        class="min-w-0 flex-1 rounded-sm bg-zinc-800 px-1 py-0.5 text-zinc-300"
        :value="currentSpeaker?.name ?? ''"
        @change="handleSpeakerChange"
      >
        <option v-for="speaker in voicevoxStore.speakers" :key="speaker.name" :value="speaker.name">
          {{ speaker.name }}
        </option>
      </select>
    </div>
    <div class="flex items-center gap-2 text-xs text-zinc-500">
      <span class="icon-[lucide--palette] size-4 shrink-0" title="Style" />
      <select
        aria-label="VOICEVOX style"
        class="min-w-0 flex-1 rounded-sm bg-zinc-800 px-1 py-0.5 text-zinc-300 disabled:opacity-50"
        :disabled="currentStyles.length <= 1"
        :value="voicevoxStore.speakerId"
        @change="handleStyleChange"
      >
        <option v-for="style in currentStyles" :key="style.id" :value="style.id">
          {{ style.name }}
        </option>
      </select>
    </div>
  </div>
</template>
