<doc lang="md">
ゲームジュース層の全画面オーバーレイ。UI 最前面 (pointer-events: none) に
パーティクル canvas / ビネット / イベントフラッシュを重ねる。

## 重ね順と操作透過

- ルート div は `fixed inset-0` + `pointer-events-none`。すべて装飾でヒットテスト対象外
- `<dialog>` / popover は top layer に乗るため、このオーバーレイより常に手前。
  ダイアログ表示中にパーティクルが被らないのは仕様 (top layer は z-index で越えられない)

## イベント反応

- pointerdown (capture): クリック位置に火花 + ボタン系 target ならクリック音。
  同時に AudioContext を unlock する (autoplay policy 対応)
- claudeFx (terminal が hook を解釈して再発行する正規化イベント): done → 花火 + ファンファーレ /
  needs-input → アラート音 + アンバーフラッシュ / running → エンゲージ音 / tool-done → チック音 /
  session-start → 起動音 / stop-failure → エラー音 + レッドフラッシュ。pending done（裏で作業
  継続中 = 真の完了ではない）は terminal 側で除去されるため、ここには届かず演出も出ない
- 通知 store: error の発生 (lastEvent) でエラー音 + レッドフラッシュ

## バーストの合流

フラッシュを伴う演出 (success / warning / error) は `fxCoalescer` を通し、実行中の演出より
優先度が高い発火だけを通す。並列 worktree からの done や複数の失敗通知は独立した非同期経路で
束になって届き、畳まないと音圧の加算とフラッシュの点滅を招く (判定を kind の同一性ではなく
優先度に置く理由は fxCoalescer.ts)。

音だけの演出は畳まない。フラッシュを持たないため、重畳しても onset の反復による点滅は起きない。
加えて tick は「ツールが 1 つ終わった」という計数情報そのもので、合流すると回数が失われる

## パフォーマンス

- canvas パーティクルはイベント発火時のみ rAF を回し、空になれば停止する (idle 時の rAF ゼロ)
- **常時アニメーションを置かない**。全画面を常時 drift させる演出 (blur +
  mix-blend-mode の環境光など) は、知覚できないほど遅い動きでも compositor に
  毎フレーム全画面の blend + blur 再合成を強制し、背後の backdrop-filter パネルの
  blur キャッシュも毎フレーム無効化するため、GPU プロセスの負荷が常時数十% に達する。
  静的なビネットは合成負荷を持たないので使ってよい
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import type { ClaudeFxEvent, HookEvent } from "../terminal";
import { createFxCoalescer } from "./fxCoalescer";
import { createParticleEngine, type ParticleEngine } from "./particleEngine";
import { sfx, unlockAudio } from "./sfx";

/** フラッシュ演出の表示時間 (ms)。CSS の animation-duration にも v-bind で流す SSOT */
const FLASH_DURATION_MS = 700;
const flashDuration = `${FLASH_DURATION_MS}ms`;

const canvasRef = useTemplateRef<HTMLCanvasElement>("fxCanvas");
let engine: ParticleEngine | undefined;

// 音・パーティクル・フラッシュは 1 セットで coalescer に渡す。畳まれた発火では
// effects が呼ばれないため、音の重畳とフラッシュの再点灯が同時に止まる。
// flashKind は演出中の kind そのもの（合流判定の state と同一）
const { kind: flashKind, run: playFx, dispose: disposeFx } = createFxCoalescer(FLASH_DURATION_MS);

useEventListener(
  window,
  "pointerdown",
  (e: PointerEvent) => {
    unlockAudio();
    engine?.spark(e.clientX, e.clientY);
    const target = e.target;
    if (target instanceof Element && target.closest("button, [role=button]") !== null) {
      sfx.click();
    }
  },
  { capture: true },
);

// Partial<Record<HookEvent, ...>> で keying することで、event 名のタイポと未対応 event を
// 型で検出する（claudeFx の event は HookEvent union）。
const HOOK_REACTIONS: Partial<Record<HookEvent, () => void>> = {
  "session-start": () => sfx.boot(),
  running: () => sfx.engage(),
  "tool-done": () => sfx.tick(),
  done: () =>
    playFx("success", () => {
      sfx.success();
      engine?.celebrate();
    }),
  "needs-input": () =>
    playFx("warning", () => {
      sfx.alert();
      engine?.alertBurst();
    }),
  "stop-failure": () => playFx("error", () => sfx.error()),
};

const disposeHook = onMessage<ClaudeFxEvent>("claudeFx", (fx) => {
  HOOK_REACTIONS[fx.event]?.();
});
onUnmounted(disposeHook);

// 通知の発生イベントを購読し、error ならエラー演出。notification store の lastEvent は
// toast の重複抑制と独立に毎回更新されるため、同一メッセージの error 再発生も取りこぼさない。
const { lastEvent } = useNotificationStore();
watch(lastEvent, (event) => {
  if (event?.type !== "error") return;
  playFx("error", () => sfx.error());
});

onMounted(() => {
  const canvas = canvasRef.value;
  if (canvas === null) return;
  engine = createParticleEngine(canvas);
});

onUnmounted(() => {
  engine?.destroy();
  disposeFx();
});
</script>

<template>
  <div class="pointer-events-none fixed inset-0" aria-hidden="true">
    <!-- 周辺減光で中央に視線を集める -->
    <div class="_fx-vignette absolute inset-0"></div>
    <!-- パーティクル -->
    <canvas ref="fxCanvas" class="absolute inset-0 size-full"></canvas>
    <!-- イベントフラッシュ (画面端の発光)。:key で kind ごとに要素を作り直しアニメーションを頭から走らせる -->
    <div
      v-if="flashKind"
      :key="flashKind"
      class="_fx-flash absolute inset-0"
      :data-kind="flashKind"
    ></div>
  </div>
</template>

<style>
._fx-vignette {
  background: radial-gradient(ellipse 120% 100% at 50% 45%, transparent 60%, var(--color-vignette));
}

/* イベント発生時に画面端を発光させるフラッシュ。色は data-kind で切り替える。
   easing はショートハンドに書かず keyframe 側が区間ごとに持つ（立ち上がりと減衰で別曲線） */
._fx-flash {
  /* 立ち上がりのピーク不透明度。強度は kind ごとに上書きする */
  --fx-flash-peak: 0.8;

  animation: fx-flash-fade v-bind(flashDuration) forwards;
}

._fx-flash[data-kind="success"] {
  box-shadow: inset 0 0 120px 10px var(--color-success);
}

._fx-flash[data-kind="warning"] {
  box-shadow: inset 0 0 120px 10px var(--color-warning-strong);
}

/* error だけ弱いのは意図的。3 色の相対輝度は Leonardo が同一コントラストで生成するため
   揃っているが、destructive だけ chroma が 25% 高く (0.207 vs 0.166 / 0.156)、
   Helmholtz-Kohlrausch 効果で同じ輝度でも強く感じる。加えて error toast は最長の
   15s 表示 + notification center に残るので、フラッシュは気づきだけ担えばよい。
   spread を外して縁の発光に留める */
._fx-flash[data-kind="error"] {
  --fx-flash-peak: 0.45;

  box-shadow: inset 0 0 90px 0 var(--color-destructive);
}

/* ピークから始めず立ち上がりに 12% を割く。全画面の輝度が瞬間的に変化すると驚愕反応を
   誘発するため、視認性を落とさない範囲で onset を鈍らせる。立ち上がりは ease-in（漸増）、
   減衰は ease-out（速く抜ける）。ショートハンドの easing は両区間とも上書きされる */
@keyframes fx-flash-fade {
  from {
    opacity: 0;
    animation-timing-function: ease-in;
  }
  12% {
    opacity: var(--fx-flash-peak);
    animation-timing-function: ease-out;
  }
  to {
    opacity: 0;
  }
}
</style>
