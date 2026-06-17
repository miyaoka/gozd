<doc lang="md">
main と subagent の生存期間を 1 本の共通時間軸に並べる横断タイムライン (Chrome DevTools 風)。

`SessionLogDialog` のヘッダ下に全幅で出す。1 トラック = 1 行で、session 行 (main + 各 subagent) の
各バーは `sessionTimeRange` が出す生存期間 (最初〜最後の ts)。バーをクリックするとその時間位置へ
seek する (親が右ペインを選択し最近傍イベントへスクロールする)。main ペインのスクロール位置は
全トラックを貫く 1 本の playhead で示す。

workflow agent はグループの見出し行 (`isHeader`) で workflow 名を 1 回だけ出し、配下の agent 行は
indent して agent 名をラベル全幅で見せる (各行に workflow 名を prefix すると幅を食って agent 名が
見切れるため)。見出し行はバーを持たず選択もできない。

## レイアウト

- gutter 列 (agent 名 + 右寄せ model) + プロット列の 2 カラムを 1 つのスクロールコンテナに入れる。プロット列は
  軸ヘッダ + バー行 + playhead を **1 つの relative content box** に収めるので、縦スクロールバーで
  幅が縮んでも全要素が同じ座標系で一致する (軸とバーがズレない。要素や座標系を分けないのが要点)
- gutter 列は先頭に軸ヘッダ高さ分の spacer を置き、バー行と縦に揃える
- ヘッダ (gutter spacer + 軸の時刻表示行) は `sticky top-0` で固定し、縦スクロールするのは agent 行
  だけ。同一スクロールコンテナ内のまま sticky にすることで、座標系を共有したままヘッダを残す
- playhead は プロット列に `absolute inset-y-0` で 1 本だけ重ね、軸ヘッダ + 全バー行を貫く
- 軸ヘッダ (時刻表示部) 自体が click/drag のシーク領域。クリックでその位置へ、左右ドラッグで連続
  シークする。シーク対象は main + 選択中 subagent の両ペイン (どちらも最近傍イベントへスナップ)
- playhead 位置 (barMs) の更新は 2 系統。ドラッグ中はカーソルの ms をリニアに示し、解放しても
  その位置を保つ (近傍化に合わせない)。ユーザーが本文をスクロールしたときだけその時刻へ移動する
  (props.playheadMs。本文側が programmatic スクロールを抑制済みなのでシーク由来では動かない)
- トラックが多い workflow 用に縦スクロール。下端ハンドルの上下ドラッグでスクロール領域の上限高さ
  (max-height) を変えられる。固定 height ではなく上限可変にすることで、少数トラックはコンパクト・
  多数トラックは拡張可能

## 設計判断

- アイコンは `iconKind` → icon component のマッピングで引き、`<component :is>` で描画する
- 生存期間 ts を持たないセッション (信頼境界外ログの病的ケース) は時間軸に置けないため、
  左端の破線 placeholder バーに倒して選択だけは可能にする (silent drop 回避)
- main は常に左ペインに出る anchor なので恒常ハイライト、選択中 subagent は別の強調色にする
- gutter ラベル右端にその agent が使った model を出す (`message.model` 実測値)。workflow グループ
  見出し行は agent ではないため model を持たず何も出さない
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, ref, watch, type FunctionalComponent, type SVGAttributes } from "vue";
import { formatModelLabel, formatSessionTime, type TimelineTrack } from "./sessionLogView";
import IconLucideGitFork from "~icons/lucide/git-fork";
import IconLucideWorkflow from "~icons/lucide/workflow";

const props = defineProps<{
  tracks: TimelineTrack[];
  axisStartMs: number;
  axisEndMs: number;
  // 右ペインで選択中の subagent id。main は常時表示なので対象外。
  activeSubId: string | undefined;
  // main ペインの現在スクロール位置 (epoch ms)。playhead の x 位置。未確定なら非表示。
  playheadMs: number | undefined;
}>();

const emit = defineEmits<{
  // バー / ラベルクリック。ms はクリックした時間位置 (ラベルクリックは生存期間先頭)。
  // 親は id で対象ペインを判定し、選択 + 最近傍イベントへスクロールする。
  (e: "seek", payload: { id: string; ms: number }): void;
  // 軸ヘッダの click / drag。ms の時間位置へ main + 選択中 subagent の両ペインをシークする
  // (どちらも最近傍イベントへ。選択中 subagent は変えない)。
  (e: "scrub", ms: number): void;
}>();

// iconKind → icon component のマッピング。
const TRACK_ICON: Record<
  NonNullable<TimelineTrack["iconKind"]>,
  FunctionalComponent<SVGAttributes>
> = {
  workflow: IconLucideWorkflow,
  subagent: IconLucideGitFork,
};

const spanMs = computed<number>(() => props.axisEndMs - props.axisStartMs);

// ms → 軸内の割合 (%)。span 0 (全 ts 同値) は 0 に倒して divide-by-zero を避ける。
function pctOf(ms: number): number {
  const span = spanMs.value;
  if (span <= 0) return 0;
  return ((ms - props.axisStartMs) / span) * 100;
}

// 要素内の x 座標 → 軸内の ms。ratio は [0,1] に clamp する (要素端ちょうど = 軸両端)。
function msFromClientX(el: HTMLElement, clientX: number): number {
  const rect = el.getBoundingClientRect();
  const ratio = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
  const clamped = Math.min(1, Math.max(0, ratio));
  return props.axisStartMs + clamped * spanMs.value;
}

// --- 時間軸スクラブ (軸ヘッダの click / drag でシーク) ---
//
// playhead の位置 barMs は 2 系統で更新する:
//   - ドラッグ中: カーソルの ms (軸上をリニアに動く)。解放後もその位置を保つ (snap しない)
//   - ユーザー操作スクロール時: そのスクロール時刻 (props.playheadMs)。本文側が programmatic
//     スクロール (シーク / ボトム追従) を抑制済みなので、シーク由来では動かず手スクロールだけ動く
// 本文 (main + 選択中 subagent) は nearestEventIndexByTs で最近傍イベントへスナップするが、
// barMs はそれに合わせない。
const scrubbing = ref(false);
const barMs = ref<number | undefined>(undefined);
// scrub の座標系は軸ヘッダ (= プロット列と同幅) の rect。pointerdown で掴んだ要素を保持。
let scrubEl: HTMLElement | undefined;

// ユーザー操作スクロール由来の playheadMs 変化に追従する (ドラッグ中はカーソルが優先)。
watch(
  () => props.playheadMs,
  (ms) => {
    if (scrubbing.value || ms === undefined) return;
    barMs.value = ms;
  },
);

interface BarStyle {
  left: string;
  width: string;
  placeholder: boolean;
}
// 生存期間バーの位置 / 幅。ts 不在は左端の placeholder (幅は CSS min-w で最小確保)。
function barStyle(track: TimelineTrack): BarStyle {
  if (track.startMs === undefined || track.endMs === undefined) {
    return { left: "0%", width: "0%", placeholder: true };
  }
  const left = pctOf(track.startMs);
  const width = pctOf(track.endMs) - left;
  return { left: `${left}%`, width: `${width}%`, placeholder: false };
}

// playhead の x 位置 (%)。位置は barMs (ドラッグ位置 / ユーザースクロール時刻) が SSOT。
// 軸範囲外 / 未確定なら undefined (非表示)。
const playheadPct = computed<number | undefined>(() => {
  const ms = barMs.value;
  if (ms === undefined) return undefined;
  if (ms < props.axisStartMs || ms > props.axisEndMs) return undefined;
  return pctOf(ms);
});

// 軸両端の時刻ラベル (日付があれば前置)。
function axisLabel(ms: number): string {
  const { date, time } = formatSessionTime(new Date(ms).toISOString());
  return date === "" ? time : `${date} ${time}`;
}
const startLabel = computed<string>(() => axisLabel(props.axisStartMs));
const endLabel = computed<string>(() => axisLabel(props.axisEndMs));

// 軸全体の経過時間ラベル (h / m / s で粒度を切り替える)。
const durationLabel = computed<string>(() => {
  const totalSec = Math.round(spanMs.value / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${min % 60}m`;
});

function isActive(track: TimelineTrack): boolean {
  return track.id === props.activeSubId;
}

// gutter ラベルに添える model 表示名。複数混在 (/model 切り替え) は中黒で連ねる。
function trackModelLabel(track: TimelineTrack): string {
  return track.models.map(formatModelLabel).join(" · ");
}

// バー描画行のクリック: x 位置を軸内の ms に変換して該当 subagent を seek する。
function onTrackClick(event: MouseEvent, track: TimelineTrack) {
  const el = event.currentTarget;
  if (!(el instanceof HTMLElement)) return;
  emit("seek", { id: track.id, ms: msFromClientX(el, event.clientX) });
}

// ラベルクリック: 選択だけが目的なので生存期間先頭へ寄せる (ts 不在は軸先頭)。
function onLabelClick(track: TimelineTrack) {
  emit("seek", { id: track.id, ms: track.startMs ?? props.axisStartMs });
}

function onScrubDown(event: PointerEvent) {
  const el = event.currentTarget;
  if (!(el instanceof HTMLElement)) return;
  scrubbing.value = true;
  scrubEl = el;
  const ms = msFromClientX(el, event.clientX);
  barMs.value = ms;
  emit("scrub", ms);
  event.preventDefault();
}

// 移動 / 解放は window で受け、scrubbing フラグでガードする (軸ヘッダの外へカーソルが出ても
// 追従する標準パターン)。useEventListener なので unmount / HMR で自動解除される。
useEventListener(window, "pointermove", (event: PointerEvent) => {
  if (!scrubbing.value || scrubEl === undefined) return;
  const ms = msFromClientX(scrubEl, event.clientX);
  barMs.value = ms;
  emit("scrub", ms);
});
useEventListener(window, "pointerup", () => {
  if (!scrubbing.value) return;
  scrubbing.value = false;
  scrubEl = undefined;
  // barMs はそのまま (解放してもドラッグ位置を保つ)。以降はユーザースクロールでのみ動く。
});

// --- 行スクロール領域の高さリサイズ (下端ハンドルをドラッグ) ---
//
// 可変にするのは height ではなく max-height。トラックが少なければコンパクトに収まり、
// workflow で agent が多いときだけスクロール上限をドラッグで広げられる (固定 height だと
// 少数トラックで空白が出る)。下限はおおよそ 2 行、上限はペインを潰さない範囲に clamp する。
const ROWS_MIN_PX = 48;
const ROWS_MAX_PX = 600;
const rowsMaxHeight = ref(176); // 既定は旧来の max-h-44 (11rem) 相当。

const dragging = ref(false);
let dragStartY = 0;
let dragStartHeight = 0;

function onHandleDown(event: PointerEvent) {
  dragging.value = true;
  dragStartY = event.clientY;
  dragStartHeight = rowsMaxHeight.value;
  event.preventDefault();
}

// pointer 移動 / 解放は window で受け、dragging フラグでガードする (ハンドル外へカーソルが
// 出ても追従する標準パターン)。useEventListener なので unmount / HMR で自動解除される。
useEventListener(window, "pointermove", (event: PointerEvent) => {
  if (!dragging.value) return;
  const next = dragStartHeight + (event.clientY - dragStartY);
  rowsMaxHeight.value = Math.min(ROWS_MAX_PX, Math.max(ROWS_MIN_PX, next));
});
useEventListener(window, "pointerup", () => {
  dragging.value = false;
});
</script>

<template>
  <div class="flex shrink-0 flex-col gap-1 border-b border-border-subtle px-3 py-2">
    <!-- gutter 列 + プロット列を 1 つのスクロールコンテナに入れ、座標系を「プロット列の content box」
         に統一する (軸ヘッダ・バー・playhead が必ず一致)。workflow で行が増えたら縦スクロールし、
         上限は下端ハンドルでリサイズ可能。overflow-x は明示 hidden (overflow-y:auto による x の auto
         昇格で バー min-width / playhead のはみ出しが横バーを出すのを防ぐ)。 -->
    <div class="overflow-x-hidden overflow-y-auto" :style="{ maxHeight: `${rowsMaxHeight}px` }">
      <div class="flex">
        <!-- gutter 列 (agent 名)。先頭に軸ヘッダ高さ分の spacer を置きバー行と縦に揃える。
             spacer は sticky で固定し、軸行と一緒に縦スクロールから外す (背景で下の行を隠す)。 -->
        <div class="w-80 shrink-0">
          <div class="sticky top-0 z-10 h-6 bg-background" />
          <template v-for="track in tracks" :key="track.id">
            <!-- workflow グループ見出し (バー無し / 非選択)。workflow 名を 1 回だけ出す。 -->
            <div
              v-if="track.isHeader"
              class="flex h-6 w-full items-center gap-1 px-1 text-[11px] font-medium text-foreground-low"
              :title="track.id"
            >
              <component
                :is="TRACK_ICON[track.iconKind]"
                v-if="track.iconKind"
                class="size-3 shrink-0"
              />
              <span class="truncate">{{ track.label }}</span>
            </div>

            <!-- main / subagent 行 (クリックで seek)。グループ配下 agent は indent する。 -->
            <button
              v-else
              type="button"
              class="flex h-6 w-full items-center gap-1 px-1 text-left text-[11px] transition-colors"
              :class="[
                track.indent ? 'pl-4' : '',
                isActive(track)
                  ? 'bg-element-hover font-medium text-foreground'
                  : track.isMain
                    ? 'font-semibold text-foreground hover:bg-element-hover'
                    : 'text-foreground-low hover:bg-element-hover hover:text-foreground',
              ]"
              :title="track.id"
              @click="onLabelClick(track)"
            >
              <component
                :is="TRACK_ICON[track.iconKind]"
                v-if="track.iconKind"
                class="size-3 shrink-0"
              />
              <span class="truncate">{{ track.label }}</span>
              <span
                v-if="track.models.length > 0"
                class="ml-auto max-w-[50%] shrink-0 truncate text-[10px] text-foreground-low tabular-nums"
                :title="trackModelLabel(track)"
              >
                {{ trackModelLabel(track) }}
              </span>
            </button>
          </template>
        </div>

        <!-- プロット列 (relative)。軸ヘッダ + バー行 + playhead を 1 つの content box に収めるので、
             スクロールバーで幅が縮んでも全要素が同じ座標系で一致する。 -->
        <div class="relative flex-1">
          <!-- 軸ヘッダ (時刻表示 + シーク領域)。クリックでその位置へ、左右ドラッグで連続シークする。
               sticky で縦スクロールから外し、固定する (agent 行だけがスクロールする)。 -->
          <div
            class="sticky top-0 z-10 flex h-6 cursor-ew-resize touch-none items-center justify-between bg-background text-[10px] text-foreground-low tabular-nums"
            @pointerdown="onScrubDown"
          >
            <span class="pointer-events-none">{{ startLabel }}</span>
            <span class="pointer-events-none">{{ durationLabel }}</span>
            <span class="pointer-events-none">{{ endLabel }}</span>
          </div>

          <!-- バー行 -->
          <template v-for="track in tracks" :key="track.id">
            <!-- 見出し行はバー無しの spacer (高さだけ揃える) -->
            <div v-if="track.isHeader" class="h-6" />
            <div v-else class="relative h-6 cursor-pointer" @click="onTrackClick($event, track)">
              <!-- 生存期間バー。placeholder (ts 不在) は破線輪郭で区別する -->
              <div
                class="absolute top-1/2 h-2 min-w-[3px] -translate-y-1/2 rounded-sm transition-colors"
                :class="
                  barStyle(track).placeholder
                    ? 'border border-dashed border-border-strong'
                    : isActive(track)
                      ? 'bg-foreground'
                      : track.isMain
                        ? 'bg-element-active'
                        : 'bg-element-hover'
                "
                :style="{ left: barStyle(track).left, width: barStyle(track).width }"
                :title="barStyle(track).placeholder ? 'no timestamps' : undefined"
              />
            </div>
          </template>

          <!-- playhead: 軸ヘッダ + 全バー行を貫く 1 本。スクラブ中はカーソル ms に追従しリニアに動く
               (本文は最近傍イベントへスナップ)。非ドラッグ時は main ペインの実スクロール位置を示す。 -->
          <div
            v-if="playheadPct !== undefined"
            class="pointer-events-none absolute inset-y-0 z-20 w-px"
            :class="scrubbing ? 'bg-foreground' : 'bg-foreground-low'"
            :style="{ left: `${playheadPct}%` }"
          />
        </div>
      </div>
    </div>

    <!-- 下端のリサイズハンドル: 上下ドラッグで行スクロール領域の上限高さを変える -->
    <div
      class="group flex h-2 cursor-row-resize touch-none items-center justify-center"
      @pointerdown="onHandleDown"
    >
      <div
        class="h-0.5 w-8 rounded-full transition-colors"
        :class="dragging ? 'bg-foreground-low' : 'bg-element group-hover:bg-element-active'"
      />
    </div>
  </div>
</template>
