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

`sandbox="allow-same-origin"` は **popup を封じるため**に付ける。`allow-popups` が無い sandbox
では中クリックや `target="_blank"` の new-window 要求を Chromium がブロックするので、
リンククリックを傍受できないこの frame から `window.open` 経路が生えない
(VS Code の webview も `allow-popups` を付けずに同じ状態を作っている)。`allow-same-origin` 自体は
sandbox による opaque 化を打ち消すだけで、origin は `gozd-preview://` のまま = renderer とは
別 origin。

## 更新の反映

配信は working tree の実ファイルを読むため、iframe を再 load しない限り編集が反映されない。
`epoch`（`usePreviewContent` の `contentEpoch`）を URL の query に載せ、content 更新のたびに
URL を変えて再 load させる。表示中 rev がディスクの実体と一致しない状態（original / commit /
PR diff / 実体なし）では consumer が target を渡さず source 表示に倒す（`canRenderHtmlNatively`）。

## リンクの遷移

左クリックは navigation になるため main の防壁が処理する。同 origin (= 配信 root 配下) への
遷移は許可されるので相対リンクで前後のページに移動でき、外部 http(s) は `shell.openExternal` に
送られる (`installExternalLinkPolicy`)。

中クリックは popup 要求なので上記のとおりブロックされ、何も起きない (VS Code の webview も
中クリックでリンクを開けない)。
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
  /** content 更新のカウンタ。増えたら iframe を再 load する */
  epoch: number;
}>();

const notify = useNotificationStore();
const src = ref<string>();

/** 固定 message + 詳細を cause に分離し、対象違いでトーストが累積しないようにする */
const URL_FAILED_MESSAGE = "Could not open HTML preview";

watch(
  () => [props.absPath, props.root, props.epoch] as const,
  async ([absPath, root, epoch]) => {
    const result = await tryCatch(rpcPreviewHtmlUrl({ absPath, root }));
    if (!result.ok) {
      src.value = undefined;
      notify.error(URL_FAILED_MESSAGE, new Error(`path=${absPath}`, { cause: result.error }));
      return;
    }
    // epoch を query に載せて URL を変え、ファイル更新で iframe を再 load させる。
    // 配信側は pathname しか見ないため query は無害（previewProtocol の previewUrlToPath）
    src.value = `${result.value.url}?e=${epoch}`;
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
    sandbox="allow-same-origin"
    title="HTML preview"
    class="size-full border-0"
    style="background: #ffffff"
  />
</template>
