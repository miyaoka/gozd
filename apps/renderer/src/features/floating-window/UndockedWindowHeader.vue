<doc lang="md">
undocked window のヘッダ枠。両 presentation (in-app パネル / 昇格後の OS ウィンドウ) が
これを使う。

枠 (border / bg / padding / gap) を 1 箇所に集約するのは、昇格時の総サイズ換算が「両
presentation のヘッダが同じ高さになる」ことを前提にするため。枠の指定が 2 箇所に分かれると、
片方だけ padding を変えた瞬間に昇格後の中身の高さが黙ってずれる。

`grabbable` は in-app パネル用で、ヘッダ全体をドラッグハンドルにする cursor だけを切り替える
(pointerdown の listener は attribute fallthrough で親が張る)。native の `draggable` 属性と
同名にしないのは、prop 宣言の有無だけが「DOM に落ちるか = ネイティブ drag が始まるか」を
分ける不安定な依存になるため。ウィンドウ操作ボタン
(in-app パネルの promote / close) は `trailing` slot に入り、中身固有のアクション (`actions`)
と同じグループに並ぶ — コードの所有権 (シェル / 中身) の境界を画面配置に漏らさないための契約。
</doc>

<script setup lang="ts">
interface Props {
  /** true でヘッダ全体をドラッグハンドルの cursor にする (in-app パネル)。 */
  grabbable?: boolean;
}

defineProps<Props>();
</script>

<template>
  <header
    class="flex shrink-0 items-start gap-2 border-b border-border bg-panel px-2 py-1"
    :class="grabbable === true ? 'cursor-grab select-none active:cursor-grabbing' : ''"
  >
    <slot name="header" />

    <div class="flex shrink-0 items-center gap-1">
      <slot name="actions" />
      <slot name="trailing" />
    </div>
  </header>
</template>
