<doc lang="md">
編集モードで縦に並ぶ repo list 1 行。左の grip を drag して並び替え、名前クリックで
アクティブ切り替え。hover / focus で ⋮ が出て ListMenu（Rename / Delete）を開く
（RepoSection ヘッダの右側アクションクラスタと同じマテリアル・同じ出し方）。

drag handle を行全体ではなく grip に分離するのは、PointerSensor が mouse + handle 上の
pointerdown を activation constraint なし（即 drag 開始）で扱うため。行ボタン自体を handle に
すると click が drag に食われて切り替えできなくなる（RepoSection は編集モード中のヘッダ click
が no-op なので行全体 handle で成立している。click と drag を同居させる本コンポーネントでは
分離が必須）。

rename / delete を行に常時露出させず ⋮ メニューに委譲するのは、特に delete が気軽に押す
操作ではないため（メニュー → 確認ダイアログの二段階）。

useSortable が per-item の setup を要求するため、SidebarPane の v-for 直書きではなく
コンポーネントに切り出している（RepoSection と同じ理由）。
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import { computed, useTemplateRef } from "vue";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideGripVertical from "~icons/lucide/grip-vertical";

const props = defineProps<{
  listId: string;
  name: string;
  index: number;
  active: boolean;
}>();

const emit = defineEmits<{
  select: [listId: string];
  openMenu: [anchorEl: HTMLElement, listId: string];
}>();

const rowEl = useTemplateRef<HTMLElement>("row");
const dragHandleEl = useTemplateRef<HTMLElement>("dragHandle");

// handle は grip button を明示指定する。PointerSensor は interactive 要素からの drag 開始を
// 拒否する（handle 登録が唯一の例外）ため button を掴むには handle が必須で、かつ mouse は
// handle 上の pointerdown を即 drag 開始で扱うため、click を持つ行ボタンとは分離する
// （<doc> 参照）。編集モードでのみ mount されるので disabled 切替は不要
useSortable({
  id: computed(() => props.listId),
  index: computed(() => props.index),
  element: rowEl,
  handle: dragHandleEl,
});

// ⋮ menu trigger。currentTarget (ボタン要素) を anchor として emit する (RepoSection と同じ規約)
function onOpenMenu(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openMenu", target, props.listId);
}
</script>

<template>
  <div ref="row" class="group/list relative flex items-center gap-0.5">
    <button
      ref="dragHandle"
      type="button"
      aria-label="Reorder list"
      class="grid size-6 shrink-0 cursor-grab place-items-center rounded-sm text-foreground-muted hover:bg-panel hover:text-foreground active:cursor-grabbing"
    >
      <IconLucideGripVertical class="size-3.5" />
    </button>
    <button
      type="button"
      :aria-pressed="active"
      :title="name"
      class="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm"
      :class="
        active
          ? 'bg-element-active text-foreground'
          : 'text-foreground-low hover:bg-panel hover:text-foreground'
      "
      @click="emit('select', listId)"
    >
      <span class="min-w-0 flex-1 truncate">{{ name }}</span>
    </button>
    <button
      type="button"
      aria-label="Open menu"
      class="absolute inset-y-0 right-1.5 my-auto grid size-5 place-items-center rounded-sm bg-panel text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-100 group-focus-within/list:opacity-100 group-hover/list:opacity-100 hover:bg-element"
      @click="onOpenMenu"
    >
      <IconLucideEllipsisVertical class="text-xs" />
    </button>
  </div>
</template>
