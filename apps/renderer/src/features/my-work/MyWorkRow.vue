<script setup lang="ts">
import type { GitMyWorkItem } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeAge, isoToUnixSec } from "../../shared/time";
import {
  activateExternalLink,
  CHECK_STATE_DISPLAY,
  ITEM_KIND_DISPLAY,
  REVIEW_DECISION_DISPLAY,
} from "../github-item";
import { RepoIcon } from "../repo-icon";
import IconLucideMessageSquare from "~icons/lucide/message-square";

const props = defineProps<{ item: GitMyWorkItem }>();

const repoIdentity = computed(() => {
  const [owner = "", name = ""] = props.item.repo.split("/");
  return { owner, name };
});

const checkDot = computed(() => {
  const state = props.item.checkState;
  return state === undefined ? undefined : CHECK_STATE_DISPLAY[state];
});

const reviewDecision = computed(() => {
  const decision = props.item.reviewDecision;
  return decision === undefined ? undefined : REVIEW_DECISION_DISPLAY[decision];
});

const dateDisplay = computed(() => formatRelativeAge(isoToUnixSec(props.item.updatedAt)));
</script>

<template>
  <a
    :href="item.url"
    class="flex items-center gap-2 border-b border-l-2 border-border-subtle px-3 py-2 text-xs no-underline hover:bg-element-hover"
    :class="item.isUnread ? 'border-l-primary' : 'border-l-transparent'"
    @click="activateExternalLink($event, item.url)"
    @auxclick="activateExternalLink($event, item.url)"
  >
    <span v-if="item.isUnread" class="sr-only">Unread</span>

    <RepoIcon :name="repoIdentity.name" :owner="repoIdentity.owner" />

    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <div class="flex items-start gap-2">
        <component
          :is="ITEM_KIND_DISPLAY[item.kind].icon"
          class="size-3.5 shrink-0 translate-y-px"
          :class="item.isDraft ? 'text-foreground-muted' : 'text-success-text'"
        />
        <span class="min-w-0 flex-1 truncate text-foreground">{{ item.title }}</span>
        <span class="shrink-0 tabular-nums" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
      </div>

      <div class="flex items-center gap-2 text-[10px] text-foreground-low">
        <span class="min-w-0 truncate">{{ item.repo }}</span>
        <span class="shrink-0 tabular-nums">#{{ item.number }}</span>
        <span v-if="item.isDraft" class="shrink-0 rounded-sm bg-element px-1 text-foreground-muted">
          draft
        </span>
        <span v-if="reviewDecision !== undefined" class="shrink-0" :class="reviewDecision.class">
          {{ reviewDecision.label }}
        </span>

        <span class="flex flex-1 items-center justify-end gap-2">
          <span
            v-if="checkDot !== undefined"
            role="img"
            class="size-1.5 shrink-0 rounded-full"
            :class="checkDot.class"
            :title="checkDot.title"
            :aria-label="checkDot.title"
          ></span>
          <span
            v-if="item.commentCount > 0"
            class="flex shrink-0 items-center gap-0.5 tabular-nums"
            :title="`Comments: ${item.commentCount}`"
          >
            <IconLucideMessageSquare class="size-2.5" />
            {{ item.commentCount }}
          </span>
          <img
            v-if="item.authorAvatarUrl !== ''"
            :src="item.authorAvatarUrl"
            :alt="item.author"
            :title="item.author"
            class="size-4 shrink-0 rounded-full"
          />
        </span>
      </div>
    </div>
  </a>
</template>
