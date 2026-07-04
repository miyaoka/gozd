<doc lang="md">
HTML ファイルのレンダリングプレビュー。ファイル内容を `srcdoc` で `<iframe>` に流し込み、
ブラウザエンジンにネイティブ描画させる。

## sandbox 契約

`sandbox=""` (全権限なし) を必須とする。`srcdoc` iframe は **デフォルトで親 origin を継承する**ため、
sandbox を外すと iframe 内 JS が renderer と同 origin で動き、親 window の
`__gozdElectronRpc`（contextBridge）に到達して任意 RPC（ファイル読み等）を叩けてしまう。

`sandbox=""` で origin を opaque 化すると:

- `<script>` は実行されない (静的 HTML + CSS のみ描画)
- 仮に scripts を許可しても opaque origin は親 window に触れず構造的に RPC を叩けない

相対パス参照 (`<img src="logo.png">` 等) は file 取得経路を持たないため解決しない。自己完結した
(CSS / asset を埋め込んだ) HTML のみ意図通り描画される。
</doc>

<script setup lang="ts">
defineProps<{
  /** レンダリング対象の HTML ソース文字列 */
  content: string;
}>();
</script>

<template>
  <!--
    sandbox="" は全権限なし契約 (doc 参照)。空文字でも属性自体は必須なので明示する。
    background は web platform の default canvas (白) に固定する。iframe 内は gozd の themed UI ではなく
    白背景前提で書かれた外部 HTML 文書を描画するため、semantic token ではなくリテラル白が意味的に正しい。
  -->
  <iframe
    :srcdoc="content"
    sandbox=""
    title="HTML preview"
    class="size-full border-0"
    style="background: #ffffff"
  />
</template>
