<doc lang="md">
編集モードで縦に並ぶ repo list 1 行。行クリックでアクティブ切り替え、行全体が drag handle で
list の並び替えができる。hover / focus で ⋮ が出て ListMenu（Rename / Delete）を開く
（RepoSection ヘッダの右側アクションクラスタと同じマテリアル・同じ出し方）。

rename / delete を行に常時露出させず ⋮ メニューに委譲するのは、特に delete が気軽に押す
操作ではないため（メニュー → 確認ダイアログの二段階）。

useSortable が per-item の setup を要求するため、SidebarPane の v-for 直書きではなく
コンポーネントに切り出している（RepoSection と同じ理由）。
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import { computed, useTemplateRef } from "vue";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";

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

// handle は行の button を明示指定する（RepoSection と同じ構成）。PointerSensor の
// preventActivation は interactive 要素 (button) からの drag 開始を拒否するが、
// handle として登録された要素は例外になるため、button を掴んで drag するには必須。
// 編集モードでのみ mount されるので disabled 切替は不要
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
  <div ref="row" class="group/list relative flex items-center">
    <button
      ref="dragHandle"
      type="button"
      :aria-pressed="active"
      :title="name"
      class="flex min-w-0 flex-1 cursor-grab items-center rounded-md px-2.5 py-1.5 text-left text-sm active:cursor-grabbing"
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
