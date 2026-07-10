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

## パフォーマンス

- canvas パーティクルはイベント発火時のみ rAF を回し、空になれば停止する (idle 時の rAF ゼロ)
- **常時アニメーションを置かない**。かつて全画面 drift する aurora (blur 80px +
  mix-blend-mode: screen の環境光) を常時演出として持っていたが、知覚できないほど
  遅い動きでも compositor は毎フレーム全画面の blend + blur 再合成を強制され、
  さらに backdrop-filter パネルの blur キャッシュを毎フレーム無効化して GPU プロセスの
  負荷が常時数十% に達したため削除した。静的なビネットは合成負荷を持たないので残す
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import type { ClaudeFxEvent, HookEvent } from "../terminal";
import { createParticleEngine, type ParticleEngine } from "./particleEngine";
import { sfx, unlockAudio } from "./sfx";

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

// Partial<Record<HookEvent, ...>> で keying することで、event 名のタイポと未対応 event を
// 型で検出する（claudeFx の event は HookEvent union）。
const HOOK_REACTIONS: Partial<Record<HookEvent, () => void>> = {
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

const disposeHook = onMessage<ClaudeFxEvent>("claudeFx", (fx) => {
  HOOK_REACTIONS[fx.event]?.();
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
