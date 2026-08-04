<doc lang="md">
HTML ファイルのレンダリングプレビュー。main の配信 scheme (`gozd-preview://`) 経由で
実 URL を `<iframe src>` に load し、ブラウザエンジンにネイティブ描画させる。

## なぜ srcdoc ではなく実 URL か

`srcdoc` に文字列を流し込むと document の base URL が親 (renderer) の URL になるため、
previewed HTML の相対リンク・画像・CSS が解決しない。origin も opaque になるので、
リンククリックを傍受する経路も無くなる。

実 URL を load すると、これらが普通の HTTP と同じ理屈で成立する。VS Code の webview が
`vscode-file://` を `registerFileProtocol` で配信し、iframe に実 URL を load させているのと
同じ形 (`platform/protocol/electron-main/protocolMainService.ts`)。

## 信頼境界

previewed HTML はリポジトリ内の任意ファイルで untrusted。実 origin を与える代わりに、
能力は main が配信時に付ける CSP で落とす (`previewProtocol.ts` の `PREVIEW_CSP`)。
script / frame / form は無効で、参照できるのは同 origin の asset と data: URI だけ。

配信範囲は `/preview/htmlUrl` に渡した root 配下に限られる。main は登録の無い path を
配信しない (VS Code の `localResourceRoots` と同型)。

origin が renderer と異なるため、iframe 内 JS から親の `__gozdElectronRpc` には到達できない
(そもそも script を CSP で止めている)。

## リンクの遷移

同 origin (= 配信 root 配下) への遷移は main の navigation 防壁が許可するため、相対リンクで
前後のページに移動できる。外部 http(s) は防壁が `shell.openExternal` に送る
(`installExternalLinkPolicy`)。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcPreviewHtmlUrl } from "./rpc";

const props = defineProps<{
  /** レンダリング対象 HTML の絶対パス */
  absPath: string;
  /** 配信を許す root の絶対パス（対象ファイルが属する worktree root） */
  root: string;
}>();

const notify = useNotificationStore();
const src = ref<string>();

/** 固定 message + 詳細を cause に分離し、対象違いでトーストが累積しないようにする */
const URL_FAILED_MESSAGE = "Could not open HTML preview";

watch(
  () => [props.absPath, props.root] as const,
  async ([absPath, root]) => {
    const result = await tryCatch(rpcPreviewHtmlUrl({ absPath, root }));
    if (!result.ok) {
      src.value = undefined;
      notify.error(URL_FAILED_MESSAGE, new Error(`path=${absPath}`, { cause: result.error }));
      return;
    }
    src.value = result.value.url;
  },
  { immediate: true },
);
</script>

<template>
  <!--
    background は web platform の default canvas (白) に固定する。iframe 内は gozd の themed UI
    ではなく白背景前提で書かれた外部 HTML 文書を描画するため、semantic token ではなくリテラル白が
    意味的に正しい。
  -->
  <iframe
    v-if="src !== undefined"
    :src="src"
    title="HTML preview"
    class="size-full border-0"
    style="background: #ffffff"
  />
</template>
