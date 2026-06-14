// WebAudio によるリアルタイム合成 SFX。音源ファイルを持たない (asset ゼロ)。
//
// AudioContext は autoplay policy の制約で user gesture 後でないと再生できないため、
// `unlockAudio()` を pointerdown ハンドラから呼んで遅延生成する。
// 全 SFX は useArcadeStore.sfxEnabled を内部で確認するので呼び出し側の分岐は不要。

import { useArcadeStore } from "./useArcadeStore";

/** マスター音量。演出音は会話やターミナル操作の邪魔をしない控えめな音圧に抑える */
const MASTER_GAIN = 0.14;

let audioCtx: AudioContext | undefined;
let masterGain: GainNode | undefined;

/** user gesture コンテキストで呼ぶ。初回呼び出しで AudioContext を生成する */
export function unlockAudio(): void {
  if (audioCtx !== undefined) {
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return;
  }
  audioCtx = new AudioContext();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = MASTER_GAIN;
  masterGain.connect(audioCtx.destination);
}

interface ToneSpec {
  /** 開始周波数 (Hz) */
  freq: number;
  /** 終了周波数。省略時は freq 固定 */
  endFreq?: number;
  type: OscillatorType;
  /** 音長 (秒) */
  duration: number;
  /** 発音開始の遅延 (秒)。アルペジオ構築用 */
  delay?: number;
  /** トーン単体の音量 (master に乗算される) */
  gain?: number;
}

function tone(spec: ToneSpec): void {
  // 発音判定はその瞬間の値だけ要るので reactive 参照は不要 (リアルタイム監視しない)
  if (!useArcadeStore().sfxEnabled) return;
  if (audioCtx === undefined || masterGain === undefined) return;
  if (audioCtx.state !== "running") return;

  const { freq, endFreq, type, duration, delay = 0, gain = 1 } = spec;
  const t0 = audioCtx.currentTime + delay;

  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + duration);
  }

  const env = audioCtx.createGain();
  // attack 3ms → exponential decay。クリックノイズ防止に 0 ではなく微小値へ落とす
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.003);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(env);
  env.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
  osc.onended = () => {
    osc.disconnect();
    env.disconnect();
  };
}

export const sfx = {
  /** ボタンクリック: 短いブリップ */
  click(): void {
    tone({ type: "square", freq: 1900, endFreq: 1400, duration: 0.045, gain: 0.5 });
  },

  /** プロンプト送信 (running): エンゲージ音。低→高の短いスイープ */
  engage(): void {
    tone({ type: "triangle", freq: 320, endFreq: 640, duration: 0.12, gain: 0.7 });
    tone({ type: "triangle", freq: 640, endFreq: 960, duration: 0.1, delay: 0.08, gain: 0.5 });
  },

  /** ツール実行完了 (tool-done): ごく小さな機械音のチック */
  tick(): void {
    tone({ type: "sine", freq: 1200, endFreq: 900, duration: 0.03, gain: 0.18 });
  },

  /** 応答完了 (done): クエストクリア風アルペジオ (C5-E5-G5-C6) */
  success(): void {
    const NOTES = [523.25, 659.25, 783.99, 1046.5];
    NOTES.forEach((freq, i) => {
      tone({ type: "triangle", freq, duration: 0.32, delay: i * 0.09, gain: 0.8 });
      // 1 オクターブ上の倍音を薄く重ねてキラキラ感を足す
      tone({ type: "sine", freq: freq * 2, duration: 0.26, delay: i * 0.09, gain: 0.18 });
    });
  },

  /** 承認待ち (asking): 2 トーンの呼び出し音 */
  alert(): void {
    tone({ type: "triangle", freq: 880, duration: 0.12, gain: 0.8 });
    tone({ type: "triangle", freq: 660, duration: 0.16, delay: 0.14, gain: 0.8 });
  },

  /** エラー: 下降するバズ音 */
  error(): void {
    tone({ type: "sawtooth", freq: 220, endFreq: 110, duration: 0.28, gain: 0.55 });
    tone({ type: "square", freq: 116, endFreq: 58, duration: 0.3, delay: 0.02, gain: 0.3 });
  },

  /** セッション開始 (session-start): 起動スイープ + 和音 */
  boot(): void {
    tone({ type: "triangle", freq: 220, endFreq: 880, duration: 0.26, gain: 0.5 });
    tone({ type: "sine", freq: 660, duration: 0.3, delay: 0.2, gain: 0.4 });
    tone({ type: "sine", freq: 990, duration: 0.34, delay: 0.24, gain: 0.3 });
  },
};
