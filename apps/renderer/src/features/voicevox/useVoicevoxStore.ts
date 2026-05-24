import type { VoicevoxSpeaker } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, readonly, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
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

/** ずんだもん（ノーマル）。voicevox 設定の唯一の SSOT */
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
  const notify = useNotificationStore();
  const enabled = ref(false);
  const speedScale = ref(DEFAULT_SPEED_SCALE);
  const volumeScale = ref(DEFAULT_VOLUME_SCALE);
  /**
   * ユーザーが明示的に選んだ speaker id。undefined はデフォルト追従 (proto3 optional の「未設定」)。
   * 永続化値が現エンジンに存在しなくても touch しない (effectiveSpeakerId が memory 上 fallback する)。
   */
  const speakerId = ref<number | undefined>(undefined);
  /** Engine `/speakers` から取得したキャラ一覧。enable + Engine 起動済みでロードされる */
  const speakers = ref<VoicevoxSpeaker[]>([]);
  /** 有効化処理中 */
  const activating = ref(false);

  /** speakers の中に該当 style.id が存在するか */
  function hasSpeakerStyle(id: number): boolean {
    return speakers.value.some((s) => s.styles.some((st) => st.id === id));
  }

  /**
   * speak 経路で実際に使う speaker id。
   * undefined / speakers にない値 / speakers ロード前で値が無い場合は DEFAULT にメモリ上 fallback する。
   * 永続化される speakerId は touch しないため、Engine 構成が一時的に変わってもユーザー選択は破壊しない。
   */
  const effectiveSpeakerId = computed(() => {
    const id = speakerId.value;
    if (id === undefined) return DEFAULT_SPEAKER_ID;
    if (speakers.value.length === 0) return id; // ロード前は信用して通す
    return hasSpeakerStyle(id) ? id : DEFAULT_SPEAKER_ID;
  });

  /**
   * 永続化された speakerId が現エンジンの speakers に存在しないか。
   * UI が「保存値は壊れていないが現在は再生に使えない」状態をユーザーに伝えるための signal。
   */
  const speakerIdIsStale = computed(() => {
    const id = speakerId.value;
    if (id === undefined) return false;
    if (speakers.value.length === 0) return false;
    return !hasSpeakerStyle(id);
  });

  /**
   * 外部から speakerId を変更する公式入口。speakers ロード後は存在検証する。
   * speakers ロード前 (config 復元中 / Engine 未起動) は無条件で受け入れる。
   */
  function setSpeakerId(id: number): void {
    if (speakers.value.length > 0 && !hasSpeakerStyle(id)) {
      notify.error(`VOICEVOX speaker id ${id} not found in current speakers list`);
      return;
    }
    speakerId.value = id;
  }

  /** 明示選択を解除しデフォルト追従に戻す。proto3 optional 上は「未設定」で永続化される */
  function resetSpeakerId(): void {
    speakerId.value = undefined;
  }

  /**
   * Engine から speakers を取得する。永続化値が現存しない場合は notify.info で伝えるのみで、
   * speakerId.value は touch しない (実効値は effectiveSpeakerId computed が DEFAULT に倒す)。
   */
  async function loadSpeakers(): Promise<void> {
    const result = await tryCatch(rpcVoicevoxListSpeakers());
    if (!result.ok) {
      notify.error("Failed to load VOICEVOX speakers", result.error);
      return;
    }
    speakers.value = result.value.speakers;
    const id = speakerId.value;
    if (id !== undefined && speakers.value.length > 0 && !hasSpeakerStyle(id)) {
      notify.info(
        `VOICEVOX speaker id ${id} not found in current engine; using default (${DEFAULT_SPEAKER_ID}) for playback`,
      );
    }
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
          speakerId: effectiveSpeakerId.value,
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
      if (cfg.speakerId !== undefined) speakerId.value = cfg.speakerId;
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
    // Engine 停止と表示の整合を取るため speakers state も clear する
    speakers.value = [];
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
    // speakerId は readonly。書き換えは setSpeakerId / resetSpeakerId を経由させる (存在検証で SSOT を守るため)
    speakerId: readonly(speakerId),
    effectiveSpeakerId,
    speakerIdIsStale,
    speakers,
    activating,
    activate,
    deactivate,
    stopAudio,
    setSpeakerId,
    resetSpeakerId,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useVoicevoxStore, import.meta.hot));
}
