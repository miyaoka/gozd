import type { VoicevoxSpeaker } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useEventListener } from "@vueuse/core";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, readonly, ref, shallowRef, watch } from "vue";
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

/** currentAudio に再生状態の同期リスナーを登録する。store 内 effect scope に
 * useEventListener で繋ぐことで HMR 時に古い listener を自動解除する */
function attachPlayingListeners(audio: HTMLAudioElement) {
  useEventListener(audio, "play", () => {
    playing.value = true;
  });
  useEventListener(audio, "ended", () => {
    playing.value = false;
  });
  useEventListener(audio, "pause", () => {
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

/**
 * 進行中の activate Promise。再 entry されたら同じ Promise を返して in-flight dedup する。
 * (sidebar の Enable ボタンと SettingsModal トグルからの連打で「進行中 = 失敗扱い」と
 * 観察される不整合を防ぐ)
 * `activating` computed の唯一の依存源として SSOT 化し、状態の二重管理を避ける。
 * shallowRef を使うのは Promise を deep-proxy しないため (内部スロットを触ると壊れる)
 */
const activationInFlight = shallowRef<Promise<boolean> | undefined>(undefined);

/** HMR 再実行時に前回のリスナーを解除するための disposer */
let disposeHookListener: (() => void) | undefined;

export const useVoicevoxStore = defineStore("voicevox", () => {
  const notify = useNotificationStore();
  const enabled = ref(false);
  const speedScale = ref(DEFAULT_SPEED_SCALE);
  const volumeScale = ref(DEFAULT_VOLUME_SCALE);
  /**
   * 現在の speaker id。初期値は DEFAULT。永続化値が現エンジンに存在しなくても touch しない
   * (effectiveSpeakerId が memory 上 fallback する)。proto3 optional は load 経路で
   * 「初期インストール (未保存)」と「ID 0 を正規値として保存」の区別にだけ使う。
   */
  const speakerId = ref<number>(DEFAULT_SPEAKER_ID);
  /** Engine `/speakers` から取得したキャラ一覧。enable + Engine 起動済みでロードされる */
  const speakers = ref<VoicevoxSpeaker[]>([]);
  /** 有効化処理中。activationInFlight の存在から derive (SSOT) */
  const activating = computed(() => activationInFlight.value !== undefined);

  /** speakers の中に該当 style.id が存在するか */
  function hasSpeakerStyle(id: number): boolean {
    return speakers.value.some((s) => s.styles.some((st) => st.id === id));
  }

  /**
   * speak 経路で実際に使う speaker id。
   * speakers ロード後に speakerId が存在しなければ DEFAULT → speakers[0].styles[0].id の順で
   * メモリ上 fallback する。永続化される speakerId は touch しないため、Engine 構成が
   * 一時的に変わってもユーザー選択は破壊しない。
   */
  const effectiveSpeakerId = computed(() => {
    const id = speakerId.value;
    if (speakers.value.length === 0) return id; // ロード前は信用して通す
    if (hasSpeakerStyle(id)) return id;
    if (hasSpeakerStyle(DEFAULT_SPEAKER_ID)) return DEFAULT_SPEAKER_ID;
    // DEFAULT も無いカスタムビルド等の稀ケース: 最初の利用可能な style に live fallback
    return speakers.value[0]?.styles[0]?.id ?? id;
  });

  /**
   * 永続化された speakerId が現エンジンの speakers に存在しないか。
   * UI が「保存値は壊れていないが現在は再生に使えない」状態をユーザーに伝えるための signal。
   */
  const speakerIdIsStale = computed(
    () => speakers.value.length > 0 && !hasSpeakerStyle(speakerId.value),
  );

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

  /**
   * Engine から speakers を取得する。永続化値が現存しない状態は speakerIdIsStale computed
   * → VoicevoxSpeakerSelect の inline 警告経由でユーザーに伝える (SSOT)。
   * speakerId.value は touch しない (実効値は effectiveSpeakerId computed が memory 上 fallback する)。
   */
  async function loadSpeakers(): Promise<void> {
    const result = await tryCatch(rpcVoicevoxListSpeakers());
    if (!result.ok) {
      notify.error("Failed to load VOICEVOX speakers", result.error);
      return;
    }
    speakers.value = result.value.speakers;
    // stale 状態 (永続値 not in speakers) は speakerIdIsStale computed → UI 側の inline 警告で伝える。
    // トースト通知をここで重複発火させない (SSOT)
  }

  /**
   * RPC 経由で Engine の起動状態を確認する。Engine 起動チェックの SSOT。
   * 3 状態を discriminated union で表現する:
   *   - `{ ok: true }`: engine が /version に 200 応答
   *   - `{ ok: false, reason: "rpc-error", error }`: RPC layer 自体が throw / network 失敗
   *   - `{ ok: false, reason: "engine-not-responding" }`: RPC は成功したが engine が応答しない
   */
  async function checkEngineRunning(): Promise<
    | { ok: true }
    | { ok: false; reason: "rpc-error"; error: Error }
    | { ok: false; reason: "engine-not-responding" }
  > {
    const result = await tryCatch(rpcVoicevoxCheckEngine());
    if (!result.ok) return { ok: false, reason: "rpc-error", error: result.error };
    if (!result.value.ok) return { ok: false, reason: "engine-not-responding" };
    return { ok: true };
  }

  /**
   * 指定回数ポーリングして Engine の起動を待つ。
   * 失敗時の戻り値は checkEngineRunning と同じ discriminated union に揃え、最終 attempt の
   * 状態を呼び出し側で明示分岐できるようにする (cause 合成のため)。
   *   - 最終 attempt が "rpc-error" なら その error を `lastError` で持ち帰る
   *   - 全 attempt が "engine-not-responding" だった通常タイムアウトは reason だけ返す
   */
  async function waitForEngine(): Promise<
    | { ok: true }
    | { ok: false; reason: "rpc-error"; lastError: Error }
    | { ok: false; reason: "engine-not-responding" }
  > {
    // 戻り値型の (ok: false を除く) suffix に揃え、最後の return が spread 1 回で済む形にする
    let lastFailure:
      | { reason: "rpc-error"; lastError: Error }
      | { reason: "engine-not-responding" }
      | undefined;
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      const result = await checkEngineRunning();
      if (result.ok) return { ok: true };
      // rpc-error は情報量が多い (RPC dispatcher 自体の障害示唆) ので、途中で観測したら
      // 以降の engine-not-responding で上書きさせない。engine-not-responding は最終状態
      // が掴めれば十分なので、rpc-error をまだ観測していない時だけ記録する
      if (result.reason === "rpc-error") {
        lastFailure = { reason: "rpc-error", lastError: result.error };
      } else if (lastFailure?.reason !== "rpc-error") {
        lastFailure = { reason: "engine-not-responding" };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // POLL_MAX_ATTEMPTS=0 の (現状到達不能な) 境界用フォールバック
    return lastFailure
      ? { ok: false, ...lastFailure }
      : { ok: false, reason: "engine-not-responding" };
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
      useEventListener(currentAudio, "ended", releaseAudio);
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
        if ((await checkEngineRunning()).ok) {
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
   * Engine が起動していなければアプリの起動を試み、失敗時は store 内で notify.error を発火する
   * (呼び出し側で表示責務を持たないように SSOT を store に集約する)。
   * 進行中に再 entry された場合は同じ Promise を返す (in-flight dedup)。
   * @returns 成功なら true、失敗 (未インストール / 起動タイムアウト 等) なら false
   */
  async function activate(): Promise<boolean> {
    if (activationInFlight.value) return activationInFlight.value;
    const work = doActivate();
    activationInFlight.value = work;
    try {
      return await work;
    } finally {
      activationInFlight.value = undefined;
    }
  }

  async function doActivate(): Promise<boolean> {
    // Engine が既に起動しているかチェック
    if ((await checkEngineRunning()).ok) {
      enabled.value = true;
      void loadSpeakers();
      return true;
    }

    // アプリの起動を試みる
    const launchResult = await tryCatch(rpcVoicevoxLaunch());
    if (!launchResult.ok || !launchResult.value.ok) {
      // launch 失敗は (a) VOICEVOX 未インストール / (b) engine binary 欠落 / (c) spawn syscall 失敗
      // の 3 種。詳細は native の stderr (VoicevoxOps.launch tag) に出る。
      // 最頻ケースは (a) なのでインストール導線を残しつつ、原因を断定しない文言にする
      const cause = !launchResult.ok
        ? launchResult.error
        : new Error("native VoicevoxLaunch returned ok=false");
      notify.error(
        "VOICEVOX engine could not start.\nIf VOICEVOX isn't installed, download it from https://voicevox.hiroshiba.jp/",
        cause,
      );
      return false;
    }

    // Engine の起動を待つ
    const waited = await waitForEngine();
    if (waited.ok) {
      enabled.value = true;
      void loadSpeakers();
      return true;
    }
    const timeoutSeconds = (POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS) / 1000;
    const cause =
      waited.reason === "rpc-error"
        ? waited.lastError
        : new Error(`engine did not respond on /version after ${timeoutSeconds}s`);
    notify.error("VOICEVOX Engine startup timed out. Please start VOICEVOX manually.", cause);
    return false;
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
    // speakerId は readonly。書き換えは setSpeakerId 経由のみ (存在検証で SSOT を守るため)
    speakerId: readonly(speakerId),
    effectiveSpeakerId,
    speakerIdIsStale,
    speakers,
    activating,
    activate,
    deactivate,
    stopAudio,
    setSpeakerId,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useVoicevoxStore, import.meta.hot));
}
