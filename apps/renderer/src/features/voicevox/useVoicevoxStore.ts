import type { VoicevoxSpeaker } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { onMessage } from "../../shared/rpc";
import { rpcLoadAppConfig, rpcSaveAppConfig } from "../settings";
import type { HookPayload } from "../terminal";
import {
  rpcVoicevoxCheckEngine,
  rpcVoicevoxLaunch,
  rpcVoicevoxListSpeakers,
  rpcVoicevoxSpeak,
} from "./rpc";
import { extractSpeechText } from "./speechText";

/** ずんだもん（ノーマル） */
const DEFAULT_SPEAKER_ID = 3;
const DEFAULT_SPEED_SCALE = 1.5;
const DEFAULT_VOLUME_SCALE = 1.0;

/** Engine 起動待ちのポーリング間隔（ms） */
const POLL_INTERVAL_MS = 500;
/** Engine 起動待ちの最大回数 */
const POLL_MAX_ATTEMPTS = 20;

/** done / needs-input を読み上げ対象として判定する */
const SPEAK_EVENTS = new Set(["done", "needs-input"]);

let currentAudio: HTMLAudioElement | undefined;
let currentObjectUrl: string | undefined;

/**
 * 再生中かどうか。モジュールスコープの ref で管理し、store から公開する。
 * Audio イベント（play / ended / pause）で同期する。
 */
const playing = ref(false);

/** currentAudio に再生状態の同期リスナーを登録する */
function attachPlayingListeners(audio: HTMLAudioElement) {
  audio.addEventListener("play", () => {
    playing.value = true;
  });
  audio.addEventListener("ended", () => {
    playing.value = false;
  });
  audio.addEventListener("pause", () => {
    playing.value = false;
  });
}

/** 現在の Audio と ObjectURL を解放する */
function releaseAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = undefined;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = undefined;
  }
}

/** speak の世代カウンター。新しい speak 呼び出しや deactivate で進め、stale なリクエストを破棄する */
let speakGeneration = 0;

/** HMR 再実行時に前回のリスナーを解除するための disposer */
let disposeHookListener: (() => void) | undefined;

export const useVoicevoxStore = defineStore("voicevox", () => {
  const enabled = ref(false);
  const speedScale = ref(DEFAULT_SPEED_SCALE);
  const volumeScale = ref(DEFAULT_VOLUME_SCALE);
  const speakerId = ref<number>(DEFAULT_SPEAKER_ID);
  /** Engine `/speakers` から取得したキャラ一覧。enable + Engine 起動済みでロードされる */
  const speakers = ref<VoicevoxSpeaker[]>([]);
  /** 有効化処理中 */
  const activating = ref(false);

  /** Engine から speakers を取得して保持する */
  async function loadSpeakers(): Promise<void> {
    const result = await tryCatch(rpcVoicevoxListSpeakers());
    if (!result.ok) return;
    speakers.value = result.value.speakers;
  }

  /** RPC 経由で Engine の起動状態を確認する */
  async function checkEngineRunning(): Promise<boolean> {
    const result = await tryCatch(rpcVoicevoxCheckEngine());
    return result.ok && result.value.ok;
  }

  /** 指定回数ポーリングして Engine の起動を待つ */
  async function waitForEngine(): Promise<boolean> {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      if (await checkEngineRunning()) return true;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  }

  /** RPC 経由で音声合成し、base64 WAV をデコードして再生する */
  async function speak(text: string, speed: number, volume: number): Promise<void> {
    releaseAudio();
    const gen = ++speakGeneration;

    const synthesize = async () => {
      const result = await tryCatch(
        rpcVoicevoxSpeak({
          text,
          speedScale: speed,
          volumeScale: volume,
          speakerId: speakerId.value,
        }),
      );
      if (!result.ok || result.value.wav.length === 0) return;
      if (gen !== speakGeneration) return;

      const blob = new Blob([new Uint8Array(result.value.wav)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      currentObjectUrl = url;
      currentAudio = new Audio(url);
      attachPlayingListeners(currentAudio);
      currentAudio.addEventListener("ended", releaseAudio);
      void currentAudio.play();
    };
    await tryCatch(synthesize());
  }

  // 起動時に設定を読み込み、enabled なら Engine の起動も試みる
  void tryCatch(rpcLoadAppConfig()).then(async (result) => {
    if (!result.ok) return;
    const cfg = result.value.config?.voicevox;
    if (cfg !== undefined) {
      if (cfg.speedScale > 0) speedScale.value = cfg.speedScale;
      if (cfg.volumeScale > 0) volumeScale.value = cfg.volumeScale;
      if (cfg.speakerId > 0) speakerId.value = cfg.speakerId;
      if (cfg.enabled) {
        enabled.value = true;
        // Engine が起動していなければバックグラウンドで起動だけ試みる（ポーリングしない）
        if (await checkEngineRunning()) {
          void loadSpeakers();
        } else {
          void tryCatch(rpcVoicevoxLaunch());
        }
      }
    }
  });

  async function saveSettings() {
    const loadResult = await tryCatch(rpcLoadAppConfig());
    if (!loadResult.ok) return;
    const config = loadResult.value.config ?? {
      terminal: undefined,
      preview: undefined,
      voicevox: undefined,
    };
    config.voicevox = {
      enabled: enabled.value,
      speedScale: speedScale.value,
      volumeScale: volumeScale.value,
      speakerId: speakerId.value,
    };
    void tryCatch(rpcSaveAppConfig(config));
  }

  // 設定変更時に保存
  watch([enabled, speedScale, volumeScale, speakerId], () => {
    void saveSettings();
  });

  /**
   * VOICEVOX を有効化する。
   * Engine が起動していなければアプリの起動を試み、
   * 未インストールなら失敗メッセージを返す。
   * @returns 失敗時のメッセージ。成功時は undefined
   */
  async function activate(): Promise<string | undefined> {
    if (activating.value) return undefined;
    activating.value = true;

    // Engine が既に起動しているかチェック
    if (await checkEngineRunning()) {
      enabled.value = true;
      void loadSpeakers();
      activating.value = false;
      return undefined;
    }

    // アプリの起動を試みる
    const launchResult = await tryCatch(rpcVoicevoxLaunch());
    if (!launchResult.ok || !launchResult.value.ok) {
      activating.value = false;
      return "VOICEVOX is not installed.\nDownload from https://voicevox.hiroshiba.jp/";
    }

    // Engine の起動を待つ
    if (await waitForEngine()) {
      enabled.value = true;
      void loadSpeakers();
      activating.value = false;
      return undefined;
    }

    activating.value = false;
    return "VOICEVOX Engine startup timed out. Please start VOICEVOX manually.";
  }

  /** 再生中の音声を停止する */
  function stopAudio() {
    speakGeneration++;
    releaseAudio();
  }

  /** VOICEVOX を無効化する。in-flight の音声合成リクエストも無効化する */
  function deactivate() {
    speakGeneration++;
    releaseAudio();
    enabled.value = false;
  }

  // --- Hook 購読（HMR 再実行時に前回のリスナーを解除するため disposer は関数外に置く） ---

  function initHookSubscription() {
    disposeHookListener?.();
    disposeHookListener = onMessage<HookPayload>("hook", (payload) => {
      if (!enabled.value) return;
      if (!SPEAK_EVENTS.has(payload.event)) return;
      // extractSpeechText は旧 snake_case payload を期待するため境界で変換する
      const legacyPayload: Record<string, unknown> = {
        ptyId: payload.ptyId,
        last_assistant_message: payload.lastAssistantMessage,
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        is_interrupt: payload.isInterrupt,
      };
      const text = extractSpeechText(payload.event, legacyPayload);
      if (text) {
        void speak(text, speedScale.value, volumeScale.value);
      }
    });
  }

  initHookSubscription();

  return {
    enabled,
    playing,
    speedScale,
    volumeScale,
    speakerId,
    speakers,
    activating,
    activate,
    deactivate,
    stopAudio,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useVoicevoxStore, import.meta.hot));
}
