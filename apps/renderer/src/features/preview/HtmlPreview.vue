<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { usePreviewServing } from "./usePreviewServing";

const props = defineProps<{
  /** レンダリング対象 HTML の絶対パス */
  absPath: string;
  /** 配信を許す root の絶対パス（対象ファイルが属する worktree root） */
  root: string;
  /** content 更新のカウンタ。増えたら iframe を再 load する */
  epoch: number;
}>();

const notify = useNotificationStore();
const src = ref<string>();

/**
 * 監視の起点。iframe ではなく常設のラッパーから document を取る。iframe は src の解決後にしか
 * 現れないため、iframe を起点にすると解決中の押下を観測できず、mount した iframe が保護の
 * 無い状態で現れる。
 *
 * global の `document` ではなく `ownerDocument` なのは、undock したパネルが別 OS ウィンドウへ
 * 昇格すると Teleport 先の document が変わり、global は opener 側を指すため。
 */
const rootRef = useTemplateRef<HTMLElement>("root");
const rootDocument = () => rootRef.value?.ownerDocument;

/** 外側でポインタが押されているか */
const outerPointerHeld = ref(false);

// - pointerup をイベント種別だけで解除に倒せない: `buttons` はそのイベント時点で押されて
//   いるボタンなので、多ボタン押下中に 1 つ離しただけで保護が外れる
// - pointermove を式から外せない: 取りこぼした pointerup をここで回収する。これが無いと
//   外れた無効化が復帰せず preview が恒久的に無反応になる
// - bubble phase では受けられない: 経路上の `@pointerdown.stop` (このコードベースの確立した
//   イディオム) 1 つで防御が無音で外れる
useEventListener(
  rootDocument,
  ["pointerdown", "pointerup", "pointermove"],
  (event: PointerEvent) => {
    outerPointerHeld.value = event.buttons !== 0;
  },
  { capture: true },
);
// cancel は押下そのものの中止なので、残っているボタンの有無によらず保護を解く。上の式に
// 載せると解除の判断を `buttons` の報告値に預けることになる
useEventListener(
  rootDocument,
  "pointercancel",
  () => {
    outerPointerHeld.value = false;
  },
  { capture: true },
);

/** 固定 message + 詳細を cause に分離し、可変の詳細は notification center (トーストの Details から開く) で読ませる */
const URL_FAILED_MESSAGE = "Could not open HTML preview";

const serving = usePreviewServing();

/**
 * 非同期レース防止のバージョンカウンター (usePreviewContent と同じ規律)。
 * 対象が短時間に変わると RPC が並行し、古い応答が後に完了すると選択中と違う HTML を描いてしまう。
 */
let requestSeq = 0;

watch(
  () => [props.absPath, props.root, props.epoch] as const,
  async ([absPath, root, epoch], prev) => {
    const mySeq = ++requestSeq;
    // 対象が変わったときだけ前の面を消す。解決までの間、別ファイルの中身を映し続けないため。
    // epoch だけの変化（保存による再 load）で消すと iframe が unmount され、往復のたびに空白が挟まる
    if (prev !== undefined && (prev[0] !== absPath || prev[1] !== root)) {
      src.value = undefined;
    }
    const result = await serving.requestUrl(absPath, root);
    if (mySeq !== requestSeq) return;
    if (!result.ok) {
      src.value = undefined;
      notify.error(URL_FAILED_MESSAGE, new Error(`path=${absPath}`, { cause: result.error }));
      return;
    }
    // epoch を query に載せて URL を変え、ファイル更新で iframe を再 load させる。
    // 配信側は pathname しか見ないため query は無害（previewUrl の parsePreviewUrl）
    src.value = `${result.value.url}?e=${epoch}`;
  },
  { immediate: true },
);
</script>

<template>
  <!-- ラッパーは常設。iframe より先に mount して押下の観測を始める (根拠は rootRef) -->
  <div ref="root" class="size-full">
    <!--
      background は web platform の default canvas (白) に固定する。iframe 内は gozd の themed UI
      ではなく白背景前提で書かれた外部 HTML 文書を描画するため、semantic token ではなくリテラル白が
      意味的に正しい。
    -->
    <iframe
      v-if="src !== undefined"
      :src="src"
      sandbox="allow-same-origin"
      title="HTML preview"
      class="size-full border-0"
      :class="{ 'pointer-events-none': outerPointerHeld }"
      style="background: #ffffff"
    />
  </div>
</template>
