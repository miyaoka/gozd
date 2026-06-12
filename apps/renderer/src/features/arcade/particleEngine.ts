// Canvas 2D パーティクルエンジン。Vue 非依存の素の TS。
//
// rAF ループは「パーティクルが生きている間 + ambient 有効中」だけ回し、
// 完全に空になったら止める (idle 時の GPU/CPU 消費ゼロ)。
//
// 色は id/index で引く有限固定 palette (gozd-ui SKILL の inline binding 例外 (c))。
// canvas の fillStyle は CSS color 文字列を受けるので OKLCH literal をそのまま使う。

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 残り寿命 (秒) */
  life: number;
  /** 初期寿命 (秒)。alpha フェードの分母 */
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
  drag: number;
  shape: "dot" | "rect";
  rotation: number;
  spin: number;
}

/** クリック火花 (シアン系) */
const SPARK_PALETTE = ["oklch(0.88 0.16 230)", "oklch(0.92 0.12 200)", "oklch(0.97 0.04 230)"];

/** 完了花火 (マルチカラー) */
const CELEBRATE_PALETTE = [
  "oklch(0.85 0.22 145)",
  "oklch(0.88 0.17 90)",
  "oklch(0.85 0.16 230)",
  "oklch(0.78 0.19 330)",
  "oklch(0.95 0.05 90)",
];

/** 警告バースト (アンバー系) */
const ALERT_PALETTE = ["oklch(0.82 0.16 70)", "oklch(0.74 0.18 45)"];

/** ambient で漂う塵 (淡いシアン) */
const EMBER_PALETTE = ["oklch(0.8 0.08 230)", "oklch(0.75 0.06 200)", "oklch(0.85 0.04 270)"];

/** ambient パーティクルの同時存在上限 */
const EMBER_CAP = 50;
/** ambient の発生間隔 (秒) */
const EMBER_SPAWN_INTERVAL = 0.25;

const TWO_PI = Math.PI * 2;

function pick<T>(arr: T[]): T {
  const [first] = arr;
  return arr[Math.floor(Math.random() * arr.length)] ?? first;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export interface ParticleEngine {
  /** クリック位置の小さな火花 */
  spark: (x: number, y: number) => void;
  /** 祝砲。画面上部のランダム位置に多重花火を打つ */
  celebrate: () => void;
  /** 警告バースト。画面右上から注意色の火花 */
  alertBurst: () => void;
  /** ambient (漂う塵) の有効/無効 */
  setAmbient: (on: boolean) => void;
  destroy: () => void;
}

export function createParticleEngine(canvas: HTMLCanvasElement): ParticleEngine | undefined {
  const maybeCtx = canvas.getContext("2d");
  if (maybeCtx === null) return undefined;
  const ctx = maybeCtx;

  let particles: Particle[] = [];
  let rafId: number | undefined;
  let lastTime = 0;
  let ambient = false;
  let emberTimer = 0;
  let destroyed = false;

  function syncSize() {
    const dpr = window.devicePixelRatio;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
  }

  function emit(p: Omit<Particle, "rotation" | "spin"> & Partial<Particle>) {
    particles.push({ rotation: rand(0, TWO_PI), spin: rand(-6, 6), ...p });
  }

  function spawnEmber() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    emit({
      x: rand(0, w),
      y: rand(h * 0.3, h + 10),
      vx: rand(-6, 6),
      vy: rand(-18, -6),
      life: rand(5, 9),
      maxLife: 8,
      size: rand(1, 2.4),
      color: pick(EMBER_PALETTE),
      gravity: 0,
      drag: 1,
      shape: "dot",
    });
  }

  function burst(x: number, y: number, count: number, palette: string[], speed: number) {
    for (let i = 0; i < count; i++) {
      const angle = rand(0, TWO_PI);
      const velocity = rand(speed * 0.25, speed);
      emit({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life: rand(0.5, 1.3),
        maxLife: 1.3,
        size: rand(1.5, 3.5),
        color: pick(palette),
        gravity: 220,
        drag: 0.985,
        shape: Math.random() < 0.35 ? "rect" : "dot",
      });
    }
  }

  function step(now: number) {
    rafId = undefined;
    if (destroyed) return;
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    syncSize();

    if (ambient) {
      emberTimer += dt;
      while (emberTimer > EMBER_SPAWN_INTERVAL) {
        emberTimer -= EMBER_SPAWN_INTERVAL;
        const emberCount = particles.filter((p) => p.gravity === 0).length;
        if (emberCount < EMBER_CAP) spawnEmber();
      }
    }

    const dpr = window.devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    // 加算合成で発光体らしく描く (dark UI 前提)
    ctx.globalCompositeOperation = "lighter";

    particles = particles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) return false;
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;

      const t = p.life / p.maxLife;
      // フェードイン/アウト両対応の山形 alpha (ambient の塵がポップしないように)
      const alpha = Math.min(1, t * 4) * Math.min(1, (1 - t) * 6 + 0.4);
      ctx.fillStyle = p.color;
      if (p.shape === "rect") {
        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillRect(-p.size, -p.size / 2, p.size * 2, p.size);
        ctx.restore();
        return true;
      }
      // 高速パーティクルは速度方向の軌跡 (streak) を引く
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 60) {
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      // 外周グロー + 明るいコアの 2 重描画
      ctx.globalAlpha = alpha * 0.22;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 3, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TWO_PI);
      ctx.fill();
      return true;
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (particles.length > 0 || ambient) schedule();
  }

  function schedule() {
    if (rafId !== undefined || destroyed) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(step);
  }

  return {
    spark(x, y) {
      burst(x, y, 10, SPARK_PALETTE, 180);
      schedule();
    },
    celebrate() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // 多重花火: 0 / 250 / 500ms で 3 連発
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          if (destroyed) return;
          burst(rand(w * 0.15, w * 0.85), rand(h * 0.12, h * 0.45), 80, CELEBRATE_PALETTE, 500);
          schedule();
        }, i * 250);
      }
    },
    alertBurst() {
      const w = canvas.clientWidth;
      burst(rand(w * 0.4, w * 0.6), 40, 24, ALERT_PALETTE, 260);
      schedule();
    },
    setAmbient(on) {
      ambient = on;
      if (on) schedule();
    },
    destroy() {
      destroyed = true;
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      particles = [];
    },
  };
}
