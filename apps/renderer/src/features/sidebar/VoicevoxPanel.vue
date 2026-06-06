<doc lang="md">
サイドバー下部の VOICEVOX 操作パネル。
有効時: スピード・ボリュームスライダーと無効化ボタンを表示。
無効時: 有効化ボタンを表示。
</doc>

<script setup lang="ts">
import { useVoicevoxStore, VoicevoxSpeakerSelect } from "../voicevox";

const voicevoxStore = useVoicevoxStore();
</script>

<template>
  <div class="border-t border-border/50 px-4 py-3">
    <template v-if="voicevoxStore.enabled">
      <div class="flex flex-col gap-2">
        <button
          v-if="voicevoxStore.playing"
          class="flex items-center gap-1 text-xs text-info hover:text-primary"
          title="Stop playback"
          @click="voicevoxStore.stopAudio()"
        >
          <span class="icon-[lucide--volume-2] size-4 shrink-0 animate-pulse" />
          <span>Playing...</span>
        </button>
        <VoicevoxSpeakerSelect />
        <div class="flex items-center gap-2 text-xs text-foreground-subtle">
          <span class="icon-[lucide--gauge] size-4 shrink-0" title="Speed" />
          <input
            type="range"
            aria-label="VOICEVOX speed"
            class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2 accent-primary"
            :min="0.5"
            :max="3.0"
            :step="0.1"
            :value="voicevoxStore.speedScale"
            @input="voicevoxStore.speedScale = Number(($event.target as HTMLInputElement).value)"
          />
          <span class="w-8 text-right tabular-nums">{{ voicevoxStore.speedScale.toFixed(1) }}</span>
        </div>
        <div class="flex items-center gap-2 text-xs text-foreground-subtle">
          <span class="icon-[lucide--volume-2] size-4 shrink-0" title="Volume" />
          <input
            type="range"
            aria-label="VOICEVOX volume"
            class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2 accent-primary"
            :min="0.0"
            :max="2.0"
            :step="0.1"
            :value="voicevoxStore.volumeScale"
            @input="voicevoxStore.volumeScale = Number(($event.target as HTMLInputElement).value)"
          />
          <span class="w-8 text-right tabular-nums">{{
            voicevoxStore.volumeScale.toFixed(1)
          }}</span>
        </div>
        <button
          class="mt-1 text-xs text-warning hover:text-warning"
          @click="voicevoxStore.deactivate()"
        >
          VOICEVOX enabled
        </button>
      </div>
    </template>
    <template v-else>
      <button
        class="flex w-full items-center justify-center gap-2 text-xs text-foreground-subtle hover:text-foreground"
        :disabled="voicevoxStore.activating"
        @click="voicevoxStore.activate()"
      >
        <span
          class="size-4 shrink-0"
          :class="
            voicevoxStore.activating
              ? 'icon-[lucide--loader] animate-spin'
              : 'icon-[lucide--volume-x]'
          "
        />
        <span>{{ voicevoxStore.activating ? "Starting VOICEVOX..." : "Enable VOICEVOX" }}</span>
      </button>
    </template>
  </div>
</template>
