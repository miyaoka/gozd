import { tryCatch } from "@orkis/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { ref, watch } from "vue";
import { useRpc } from "../rpc/useRpc";

const VOICEVOX_API = "http://127.0.0.1:50021";
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

/** マークダウン記法を除去してテキストの一行目を取得する */
function extractFirstLine(message: string): string | undefined {
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    return trimmed.replace(/[*_`#]/g, "");
  }
  return undefined;
}

/** asking 時の読み上げテキストを抽出する */
function extractAskingText(toolName: string | undefined, toolInput: unknown): string | undefined {
  if (
    toolName === "AskUserQuestion" &&
    typeof toolInput === "object" &&
    toolInput !== null &&
    "questions" in toolInput &&
    Array.isArray(toolInput.questions)
  ) {
    const [first] = toolInput.questions;
    if (
      typeof first === "object" &&
      first !== null &&
      "question" in first &&
      typeof first.question === "string"
    ) {
      return first.question;
    }
  }
  return toolName;
}

/** payload からイベントに応じた読み上げテキストを抽出する */
function extractSpeechText(event: string, payload: Record<string, unknown>): string | undefined {
  if (event === "done") {
    const message =
      typeof payload.last_assistant_message === "string"
        ? payload.last_assistant_message
        : undefined;
    if (message) return extractFirstLine(message);
    return undefined;
  }
  if (event === "needs-input") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    return extractAskingText(toolName, payload.tool_input);
  }
  return undefined;
}

/** VOICEVOX Engine の /version を叩いて起動チェックする */
async function checkEngineRunning(): Promise<boolean> {
  const result = await tryCatch(fetch(`${VOICEVOX_API}/version`));
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

/** VOICEVOX Engine で音声合成して再生する */
async function speak(
  text: string,
  speedScale: number,
  volumeScale: number,
  speakerId = DEFAULT_SPEAKER_ID,
): Promise<void> {
  releaseAudio();

  const queryResult = await tryCatch(
    fetch(`${VOICEVOX_API}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, {
      method: "POST",
    }),
  );
  if (!queryResult.ok) return;
  if (!queryResult.value.ok) return;

  const query = await queryResult.value.json();
  query.speedScale = speedScale;
  query.volumeScale = volumeScale;

  const audioResult = await tryCatch(
    fetch(`${VOICEVOX_API}/synthesis?speaker=${speakerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    }),
  );
  if (!audioResult.ok) return;
  if (!audioResult.value.ok) return;

  const blob = await audioResult.value.blob();
  const url = URL.createObjectURL(blob);
  currentObjectUrl = url;
  currentAudio = new Audio(url);
  currentAudio.addEventListener("ended", releaseAudio);
  void currentAudio.play();
}

/** HMR 再実行時に前回のリスナーを解除するための disposer */
let disposeHookListener: (() => void) | undefined;

export const useVoicevoxStore = defineStore("voicevox", () => {
  const { request, onOrkisHook } = useRpc();
  const enabled = ref(false);
  const speedScale = ref(DEFAULT_SPEED_SCALE);
  const volumeScale = ref(DEFAULT_VOLUME_SCALE);
  /** 有効化処理中 */
  const activating = ref(false);

  // 起動時に設定を読み込む
  void tryCatch(request.configLoad()).then((result) => {
    if (!result.ok) return;
    const voicevox = result.value.voicevox;
    if (!voicevox) return;
    if (typeof voicevox.enabled === "boolean") enabled.value = voicevox.enabled;
    if (typeof voicevox.speedScale === "number") speedScale.value = voicevox.speedScale;
    if (typeof voicevox.volumeScale === "number") volumeScale.value = voicevox.volumeScale;
  });

  function saveSettings() {
    void tryCatch(
      request.configSave({
        voicevox: {
          enabled: enabled.value,
          speedScale: speedScale.value,
          volumeScale: volumeScale.value,
        },
      }),
    );
  }

  // 設定変更時に保存
  watch([enabled, speedScale, volumeScale], saveSettings);

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
      activating.value = false;
      return undefined;
    }

    // アプリの起動を試みる
    const launchResult = await tryCatch(request.voicevoxLaunch());
    if (!launchResult.ok || !launchResult.value) {
      activating.value = false;
      return "VOICEVOX がインストールされていません。\nhttps://voicevox.hiroshiba.jp/ からダウンロードしてください。";
    }

    // Engine の起動を待つ
    if (await waitForEngine()) {
      enabled.value = true;
      activating.value = false;
      return undefined;
    }

    activating.value = false;
    return "VOICEVOX Engine の起動がタイムアウトしました。VOICEVOX を手動で起動してください。";
  }

  /** VOICEVOX を無効化する */
  function deactivate() {
    releaseAudio();
    enabled.value = false;
  }

  // --- Hook 購読（HMR 再実行時に前回のリスナーを解除するため disposer は関数外に置く） ---

  function initHookSubscription() {
    disposeHookListener?.();
    disposeHookListener = onOrkisHook(({ event, payload }) => {
      if (!enabled.value) return;
      if (!SPEAK_EVENTS.has(event)) return;
      const text = extractSpeechText(event, payload);
      if (text) {
        void speak(text, speedScale.value, volumeScale.value);
      }
    });
  }

  initHookSubscription();

  return { enabled, speedScale, volumeScale, activating, activate, deactivate };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useVoicevoxStore, import.meta.hot));
}
