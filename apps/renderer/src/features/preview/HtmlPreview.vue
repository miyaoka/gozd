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

URL の host 部はこの instance の id で、**origin が preview ごとに分かれる**。同一 origin だと
CSP の `'self'` が preview 間の壁にならず、別 preview の root 配下を参照できてしまう。許可も
id に紐づき、unmount で `/preview/releaseHtml` して手放す。

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

## 外側のポインタ操作を奪わない

契約は [docs/preview.md](../../../../../docs/preview.md) の HTML ビュー。ここには判定をこの面に
置いた理由と、このコンポーネントの都合から来る制約だけを書く。

cross-origin の frame を跨いでイベントが届くのは pointer capture を持つドラッグだけで、
持たないドラッグは frame に吸われ、外側から傍受する経路も無い。

判定を外側のドラッグではなくこの面に置くのは、**外側に規律を課しても届かない実装があるため**。
xterm.js のテキスト選択は pointer capture を使わず、gozd から実装を変えられない。「全ての
ドラッグが capture する」も「全てのドラッグがドラッグ中を宣言する」も到達できない前提であり、
そこに依存する設計は成立しない。この面が自分で押下を観測するなら、外側が何であっても成立する。

このコンポーネント固有の制約:

- 押下が始まった時点でこの面がまだ現れていなければ、現れた直後は保護が効かないことがある
- 押下の起点がこの面の中か外かを cross-origin では観測できないため、起点で分岐して
  この面の中で始まったドラッグを保護の対象外にする実装は採れない
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { useEventListener } from "@vueuse/core";
import { onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcPreviewHtmlUrl, rpcPreviewReleaseHtml } from "./rpc";

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

/** 外側でポインタが押されているか (doc の「外側のポインタ操作を奪わない」) */
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

/** 固定 message + 詳細を cause に分離し、対象違いでトーストが累積しないようにする */
const URL_FAILED_MESSAGE = "Could not open HTML preview";

/**
 * URL 取得要求の直列化。前回の要求が終わってから次を始める。
 *
 * main は「最後に完了した要求」の root を配信許可として保持するため、並行させると repo をまたぐ
 * 素早い切替で完了順が逆転し、許可が前の root に残ったまま新しい URL を読みに行って 403 になる
 * （renderer 側の版数ガードは src の取り違えしか防げない）。発射順 = 処理順にすれば起きない。
 */
let pending: Promise<unknown> = Promise.resolve();

/**
 * 非同期レース防止のバージョンカウンター (usePreviewContent と同じ規律)。
 * 対象が短時間に変わると RPC が並行し、古い応答が後に完了すると選択中と違う HTML を描いてしまう。
 */
let requestSeq = 0;

/**
 * この preview instance の識別子。main が配信許可 (root) をこの id に紐づけて保持し、
 * unmount で解放する。解放しないと閉じた preview の root が残り、別の preview がその配下を
 * 読めてしまう。
 */
const previewId = crypto.randomUUID();

watch(
  () => [props.absPath, props.root, props.epoch] as const,
  async ([absPath, root, epoch], prev) => {
    const mySeq = ++requestSeq;
    // 対象が変わったときだけ前の面を消す。解決までの間、別ファイルの中身を映し続けないため。
    // epoch だけの変化（保存による再 load）で消すと iframe が unmount され、往復のたびに空白が挟まる
    if (prev !== undefined && (prev[0] !== absPath || prev[1] !== root)) {
      src.value = undefined;
    }
    const run = pending.then(() => tryCatch(rpcPreviewHtmlUrl({ absPath, root, previewId })));
    // 失敗しても次の要求を止めないよう、chain 自体は解決済みに保つ
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    const result = await run;
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

onBeforeUnmount(() => {
  // 解放も同じキューに載せる。直列化しないと、in-flight の htmlUrl が解放の後に完了して
  // grant を再登録し、閉じた preview の配信許可がプロセスの生存期間ずっと残る。
  // 解放できなくても UI 上は何も起きないので観察ログを残す
  pending = pending.then(() =>
    tryCatch(rpcPreviewReleaseHtml({ previewId })).then((released) => {
      if (!released.ok) {
        console.error(`[HtmlPreview] failed to release preview root: ${String(released.error)}`);
      }
    }),
  );
});
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
