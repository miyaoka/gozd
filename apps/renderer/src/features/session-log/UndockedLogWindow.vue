<doc lang="md">
undock されたセッションログメッセージ 1 件の独立 OS ウィンドウ。

ウィンドウの実体は別 OS ウィンドウで、生成・スタイル複製・close 経路は汎用シェル
ChildWindow に委譲。移動 / リサイズ / 前面順は OS ネイティブに任せる。ここはヘッダ内容
(TerminalLeafTitle と同じ repo + session タイトルの 2 段構成) と kind 別配色の本文
スクロール面だけを担う。

内容は undock 時点の凍結スナップショットで dirty 状態を持たないため、close はガードなし
(blockClose 常時 false。ネイティブ close / cmd+w がそのまま通る)。cmd+s
(childWindow.save) は保存対象が無いので配線しない。タイトルバー (document.title) は
session タイトル。

undock 直後は、旧 in-app FloatingWindow と同じ plain fixed のゴーストをその場に描く。
child window の表示 (ready-to-show 後の show) までわずかに間があり、埋めないと undock 元も
child も不可視の隙間が点滅する。配置は旧 FloatingWindow の射影 style (`left: min(...)` /
`top: clamp(...)` / zIndex) をそのまま使う。本 component は UndockedLogLayer (App root)
配下に mount されるため、旧 FloatingWindow と同じ文脈で fixed 配置できる。

ゴーストの解除は child window の表示完了 push (`childWindowShown`。main が OS の show
event を転送) を合図にするイベント駆動。push が落ちた場合 (renderer 再構築中等) に
ゴーストが永久残留しないよう、timeout の保険でも解除する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { onMounted, ref, useTemplateRef } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { ChildWindow, rpcChildWindowResizeBy } from "../floating-window";
import { RepoIcon } from "../repo-icon";
import SessionLogMessageBody from "./SessionLogMessageBody.vue";
import { useUndockedLog, type UndockedLog } from "./useUndockedLog";

interface Props {
  log: UndockedLog;
}

const props = defineProps<Props>();
const { close, takeHandoff } = useUndockedLog();

// popover ヘッダのドラッグから undock された場合の引き継ぎ。setup で 1 回だけ消費する
// (undock() → 描画フラッシュ → setup が同期で完結するため、setup 時点で必ず取得できる)。
const handoff = takeHandoff(props.log.id);

// 総高さの決定は旧 FloatingWindow と同じ方式: 受け取った height は本文 (スクロール面) の
// 高さで、mount 後にヘッダの実測高をウィンドウに足す。これで本文高が undock 前後で
// 一致する (ヘッダ高を定数で持つと実描画とずれて本文が欠ける / 余るため実測が SSOT)。
// 実測は child 側ヘッダではなく**ゴースト側ヘッダ**で行う — child document の複製 CSS は
// packaged では <link rel=stylesheet> でシート適用が非同期になり、mount 直後の同期実測が
// UA 既定スタイルの高さを読む恐れがある。ゴーストは main window 内で CSS 適用済みかつ
// markup / class / 幅が child ヘッダと同一なので高さも一致する。
// 加算は renderer の resizeBy ではなく RPC 経由で main が実 bounds に対して行う
// (renderer の resize API は Blink キャッシュ基準で実 bounds とずれる。rpc.ts の doc 参照)。
// open 失敗時は opened が emit されず frameName が undefined のままなので何もしない。
const notification = useNotificationStore();
const frameName = ref<string>();
const ghostHeaderRef = useTemplateRef<HTMLElement>("ghostHeader");
onMounted(() => {
  const header = ghostHeaderRef.value;
  const frame = frameName.value;
  if (header === null || frame === undefined) return;
  void tryCatch(
    rpcChildWindowResizeBy({
      frameName: frame,
      deltaHeight: Math.round(header.getBoundingClientRect().height),
    }),
  ).then((result) => {
    // one-shot の恒久補正なので、失敗すると本文がヘッダ分欠けたまま固定される。通知する
    if (!result.ok) notification.error("Failed to size undocked log window", result.error);
  });
});

// ==== undock 直後のその場固定ゴースト (doc 参照) ====

/** 旧 FloatingWindow と同じ、画面内へ残す掴み代 (px)。射影 style の定数。 */
const GRAB_MARGIN = 80;
/** 旧 useFloatingWindows の Z_BASE と同じ。plain fixed 要素どうしの相対順にだけ効く。 */
const GHOST_Z = 30;

// ゴーストの viewport 座標。store が持つのは child window 生成用のスクリーン座標なので、
// undock 元 (TerminalSessionPreview) と同じ chromeY = outer/inner 差で逆換算する
const ghostChromeY = window.outerHeight - window.innerHeight;
const ghostX = props.log.screenX - window.screenX;
const ghostY = props.log.screenY - window.screenY - ghostChromeY;

/** ゴースト残留の保険 timeout (ms)。表示完了 push (通常 +50ms 程度で届く) が落ちた場合の
 * 自己回復。値は push の実測所要より十分大きく、残留として知覚される長さより短い。 */
const GHOST_TIMEOUT_MS = 500;

// 解除は ChildWindow の shown (表示完了 push) を合図にするイベント駆動 + timeout 保険 (doc 参照)
const ghostVisible = ref(true);
onMounted(() => {
  setTimeout(() => {
    ghostVisible.value = false;
  }, GHOST_TIMEOUT_MS);
});
</script>

<template>
  <!-- undock 直後、child window の表示完了まで出すゴースト。配置 style は旧 FloatingWindow
       の射影クランプをそのまま使う (doc 参照)。表示専用のため pointer-events は透過 -->
  <section
    v-if="ghostVisible"
    aria-hidden="true"
    class="pointer-events-none fixed flex flex-col overflow-hidden rounded-md border border-border-strong bg-background shadow-xl"
    :style="{
      left: `min(${ghostX}px, calc(100vw - ${GRAB_MARGIN}px))`,
      top: `clamp(var(--titlebar-height), ${ghostY}px, calc(100vh - ${GRAB_MARGIN}px))`,
      width: `${log.width}px`,
      zIndex: GHOST_Z,
    }"
  >
    <!-- ゴースト側ヘッダが総高さ実測の対象 (script 内コメント参照)。child 側ヘッダと
         markup / class を一致させ続けること -->
    <header
      ref="ghostHeader"
      class="flex shrink-0 items-start gap-2 border-b border-border bg-panel px-2 py-1"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div v-if="log.repoName !== ''" class="flex items-center gap-2">
          <RepoIcon :name="log.repoName" :owner="log.repoOwner" />
          <span class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide">
            {{ log.repoName }}
          </span>
        </div>
        <h2 class="truncate text-xs text-foreground-low" :title="log.title">
          {{ log.title }}
        </h2>
      </div>
    </header>
    <div
      class="min-h-0 overflow-hidden"
      :class="log.kind === 'assistant' ? 'bg-chat-incoming' : 'bg-chat-outgoing'"
      :style="{ height: `${log.height}px` }"
    >
      <SessionLogMessageBody :kind="log.kind" :text="log.text" />
    </div>
  </section>

  <ChildWindow
    :title="log.title"
    :screen-x="log.screenX"
    :screen-y="log.screenY"
    :width="log.width"
    :height="log.height"
    :block-close="false"
    :handoff="handoff"
    @opened="frameName = $event"
    @shown="ghostVisible = false"
    @close="close(log.id)"
  >
    <!-- OS ウィンドウ全面を占めるルート。テキスト / 背景の既定は複製 CSS の Tier 3 でも
         当たるが、ルートで明示して child 側の描画を自立させる -->
    <div class="flex h-screen flex-col bg-background text-foreground">
      <!-- TerminalLeafTitle と同じ 2 段構成 (上段: repo アイコン + repo 名 / 下段: session
           タイトル)。repo 未解決 (空文字) は上段ごと省く。close はネイティブ titlebar に任せる -->
      <header class="flex shrink-0 items-start gap-2 border-b border-border bg-panel px-2 py-1">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div v-if="log.repoName !== ''" class="flex items-center gap-2">
            <RepoIcon :name="log.repoName" :owner="log.repoOwner" />
            <span class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide">
              {{ log.repoName }}
            </span>
          </div>
          <h2 class="truncate text-xs text-foreground-low" :title="log.title">
            {{ log.title }}
          </h2>
        </div>
      </header>

      <div
        class="min-h-0 flex-1 overflow-auto select-text"
        :class="log.kind === 'assistant' ? 'bg-chat-incoming' : 'bg-chat-outgoing'"
      >
        <SessionLogMessageBody :kind="log.kind" :text="log.text" />
      </div>
    </div>
  </ChildWindow>
</template>
