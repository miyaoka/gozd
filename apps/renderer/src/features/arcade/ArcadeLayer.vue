<doc lang="md">
ゲームジュース層の全画面オーバーレイ。UI 最前面 (pointer-events: none) に
パーティクル canvas / ビネット / オーロラ / イベントフラッシュを重ねる。

## 重ね順と操作透過

- ルート div は `fixed inset-0` + `pointer-events-none`。すべて装飾でヒットテスト対象外
- `<dialog>` / popover は top layer に乗るため、このオーバーレイより常に手前。
  ダイアログ表示中にパーティクルが被らないのは仕様 (top layer は z-index で越えられない)

## イベント反応

- pointerdown (capture): クリック位置に火花 + ボタン系 target ならクリック音。
  同時に AudioContext を unlock する (autoplay policy 対応)
- hook push: done → 花火 + ファンファーレ / needs-input → アラート音 + アンバーフラッシュ /
  running → エンゲージ音 / tool-done → チック音 / session-start → 起動音 /
  stop-failure → エラー音 + レッドフラッシュ
- 通知 store: error の発生 (lastEvent) でエラー音 + レッドフラッシュ

## パフォーマンス

- canvas パーティクルはイベント発火時のみ rAF を回し、空になれば停止する (idle 時の rAF ゼロ)
- 一方 aurora / 各種グローは CSS 合成による**常時演出**。GPU レイヤーは
  保持され続けるため、canvas のような完全停止はせず idle 時も合成負荷が残る。
  aurora は `will-change: transform` で常時 drift するため、無負荷ではない点に注意
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { createParticleEngine, type ParticleEngine } from "./particleEngine";
import { sfx, unlockAudio } from "./sfx";

/** hook push payload のうち arcade が使う部分 (payload 型は feature 定義の規約) */
interface ArcadeHookPayload {
  event: string;
}

/** フラッシュ演出の表示時間 (ms)。CSS の _fx-flash アニメーション長と揃える */
const FLASH_DURATION_MS = 700;

const canvasRef = useTemplateRef<HTMLCanvasElement>("fxCanvas");
let engine: ParticleEngine | undefined;

const flashKind = ref<"warning" | "error" | "success" | undefined>(undefined);
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flash(kind: "warning" | "error" | "success") {
  // 連続発火で再生し直すため一度 undefined に戻してから次フレームで再設定する
  flashKind.value = undefined;
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  requestAnimationFrame(() => {
    flashKind.value = kind;
    flashTimer = setTimeout(() => {
      flashKind.value = undefined;
    }, FLASH_DURATION_MS);
  });
}

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

const HOOK_REACTIONS: Record<string, () => void> = {
  "session-start": () => sfx.boot(),
  running: () => sfx.engage(),
  "tool-done": () => sfx.tick(),
  done: () => {
    sfx.success();
    engine?.celebrate();
    flash("success");
  },
  "needs-input": () => {
    sfx.alert();
    engine?.alertBurst();
    flash("warning");
  },
  "stop-failure": () => {
    sfx.error();
    flash("error");
  },
};

const disposeHook = onMessage<ArcadeHookPayload>("hook", (payload) => {
  HOOK_REACTIONS[payload.event]?.();
});
onUnmounted(disposeHook);

// 通知の発生イベントを購読し、error ならエラー演出。notification store の lastEvent は
// toast の重複抑制と独立に毎回更新されるため、同一メッセージの error 再発生も取りこぼさない。
const { lastEvent } = useNotificationStore();
watch(lastEvent, (event) => {
  if (event?.type !== "error") return;
  sfx.error();
  flash("error");
});

onMounted(() => {
  const canvas = canvasRef.value;
  if (canvas === null) return;
  engine = createParticleEngine(canvas);
});

onUnmounted(() => {
  engine?.destroy();
  if (flashTimer !== undefined) clearTimeout(flashTimer);
});
</script>

<template>
  <div class="pointer-events-none fixed inset-0" aria-hidden="true">
    <!-- ゆっくり漂う環境光 (additive blend で暗部だけ持ち上げる) -->
    <div class="_fx-aurora absolute inset-0"></div>
    <!-- 周辺減光で中央に視線を集める -->
    <div class="_fx-vignette absolute inset-0"></div>
    <!-- パーティクル -->
    <canvas ref="fxCanvas" class="absolute inset-0 size-full"></canvas>
    <!-- イベントフラッシュ (画面端の発光) -->
    <div v-if="flashKind" class="_fx-flash absolute inset-0" :data-kind="flashKind"></div>
  </div>
</template>

<style>
._fx-vignette {
  background: radial-gradient(ellipse 120% 100% at 50% 45%, transparent 60%, oklch(0 0 0 / 0.3));
}

._fx-aurora {
  opacity: 0.5;
  mix-blend-mode: screen;
}

._fx-aurora::before,
._fx-aurora::after {
  content: "";
  position: absolute;
  width: 60vw;
  height: 60vh;
  border-radius: 50%;
  filter: blur(80px);
  will-change: transform;
}

._fx-aurora::before {
  background: radial-gradient(
    circle,
    color-mix(in oklch, var(--color-fx-aurora-blue) 16%, transparent),
    transparent 70%
  );
  top: -20%;
  left: -10%;
  animation: fx-drift-a 26s ease-in-out infinite alternate;
}

._fx-aurora::after {
  background: radial-gradient(
    circle,
    color-mix(in oklch, var(--color-fx-mesh-violet) 12%, transparent),
    transparent 70%
  );
  bottom: -25%;
  right: -10%;
  animation: fx-drift-b 34s ease-in-out infinite alternate;
}

@keyframes fx-drift-a {
  from {
    transform: translate(0, 0) scale(1);
  }
  to {
    transform: translate(30vw, 20vh) scale(1.3);
  }
}

@keyframes fx-drift-b {
  from {
    transform: translate(0, 0) scale(1.2);
  }
  to {
    transform: translate(-25vw, -15vh) scale(0.9);
  }
}

/* イベント発生時に画面端を発光させるフラッシュ。色は data-kind で切り替える */
._fx-flash {
  animation: fx-flash-fade 0.7s ease-out forwards;
}

._fx-flash[data-kind="success"] {
  box-shadow: inset 0 0 120px 10px var(--color-success);
}

._fx-flash[data-kind="warning"] {
  box-shadow: inset 0 0 120px 10px var(--color-warning-strong);
}

._fx-flash[data-kind="error"] {
  box-shadow: inset 0 0 120px 10px var(--color-destructive);
}

@keyframes fx-flash-fade {
  from {
    opacity: 0.8;
  }
  to {
    opacity: 0;
  }
}
</style>
