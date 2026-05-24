<doc lang="md">
VOICEVOX のキャラとスタイルを 2 段 select で選ぶコンポーネント。
キャラを変更したら、そのキャラの先頭 style の id に切り替える。

## stale speakerId

保存された speakerId が現エンジンに存在しない場合、`effectiveSpeakerId` (再生用) はデフォルトに倒れるが、
ユーザー選択 (`speakerId`) は保持される。この時 inline 警告と Reset to default ボタンを出す。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { useVoicevoxStore } from "../voicevox";

const voicevoxStore = useVoicevoxStore();

// effectiveSpeakerId ベースで表示する → ユーザーが見ている select と実際の再生音声が一致する
const currentSpeaker = computed(() =>
  voicevoxStore.speakers.find((s) =>
    s.styles.some((style) => style.id === voicevoxStore.effectiveSpeakerId),
  ),
);

const currentStyles = computed(() => currentSpeaker.value?.styles ?? []);

function handleSpeakerChange(event: Event) {
  const speakerName = (event.target as HTMLSelectElement).value;
  const speaker = voicevoxStore.speakers.find((s) => s.name === speakerName);
  const firstStyleId = speaker?.styles[0]?.id;
  if (firstStyleId !== undefined) {
    voicevoxStore.setSpeakerId(firstStyleId);
  }
}

function handleStyleChange(event: Event) {
  voicevoxStore.setSpeakerId(Number((event.target as HTMLSelectElement).value));
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <template v-if="voicevoxStore.speakers.length > 0">
      <div
        v-if="voicevoxStore.speakerIdIsStale"
        class="flex items-start gap-2 rounded-sm bg-amber-950/40 px-2 py-1 text-xs text-amber-300"
      >
        <span class="icon-[lucide--triangle-alert] size-4 shrink-0" />
        <div class="flex-1">
          Saved speaker (id {{ voicevoxStore.speakerId }}) is not in current engine; playing with
          default.
          <button
            type="button"
            class="ml-1 underline hover:text-amber-200"
            @click="voicevoxStore.resetSpeakerId()"
          >
            Reset
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2 text-xs text-zinc-500">
        <span class="icon-[lucide--user] size-4 shrink-0" title="Character" />
        <select
          aria-label="VOICEVOX character"
          class="min-w-0 flex-1 rounded-sm bg-zinc-800 px-1 py-0.5 text-zinc-300"
          :value="currentSpeaker?.name ?? ''"
          @change="handleSpeakerChange"
        >
          <option
            v-for="speaker in voicevoxStore.speakers"
            :key="speaker.name"
            :value="speaker.name"
          >
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
          :value="voicevoxStore.effectiveSpeakerId"
          @change="handleStyleChange"
        >
          <option v-for="style in currentStyles" :key="style.id" :value="style.id">
            {{ style.name }}
          </option>
        </select>
      </div>
    </template>
    <div v-else class="text-xs text-zinc-500 italic">Enable VOICEVOX to load characters</div>
  </div>
</template>
