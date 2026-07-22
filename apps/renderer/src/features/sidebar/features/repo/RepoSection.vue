<doc lang="md">
1 つの repo を表すサイドバーセクション。

ヘッダ (repo アイコン + repo 名 + 展開時のみ 2 行目に GitHub owner + chevron + 編集モード時の ✕) と、
配下の WtCard 列 (main wt 先頭固定、その後 worktrees 配列順) + `+ New worktree`。

## 並び順

1. main wt
2. その他 wt: repoStore.worktrees の append 順を維持 (= git worktree list の順)
3. `+ New worktree` ボタン

state による並び替えは行わない。Claude 起動 / 状態遷移でカード位置が動くと
「どこに何があるか」を覚えていられないため、位置は静的に保ち、状態は state
アイコンで識別する。

claude ビュー中は Claude セッションが動いている wt カードだけに絞り、`+ New worktree` も
隠す（実行中セッションのフィルタ表示に作成導線は不整合なため）。並び替えはせずフィルタ
（非表示）だけに留め、位置の安定性の規律を保つ。対象 wt を持つ repo は collapse 状態を
無視して展開する（terminal のタイルは collapse と無関係に出るため、畳んだままだと
「タイルには agent が見えるがサイドバーはヘッダのみ」の非対称が生じる）。

## 操作

- header 全体クリック: git repo は折りたたみトグル (永続)、非 git project は rootDir を
  active dir に選択 (ファイラー表示の唯一の経路)。非 git は worktree カードを持たず畳む対象が
  無いため chevron も出さない。編集モード中はどちらも無効
- 編集モードのヘッダは通常モードと完全に別描画: grip（drag handle）+ 非インタラクティブな
  名前表示 + ✕ のみで、_fx-shine の hover 演出もクリックも持たない。grip を分離するのは
  ListRow と同じ理由（mouse は handle 上の pointerdown を即 drag 開始で扱う）に加え、
  通常時との見分けを付けるため。✕ は他 repo list にも属する repo なら「アクティブ repo list
  から外す」、最後の所属なら「window から解除」（`removesFromWindow` prop でラベルを
  出し分け、分岐の実体は SidebarPane）

## レイアウト（行 = full-bleed）

VS Code の pane header / tree row と同じ原則で、header は panel 幅いっぱいの
1 コントロールにする（section は padding を持たず、padding は header 内の button と
コンテンツ列が各自持つ）。focus ring / hover は常に行全体に付き、collapsed 時は
panel = header だけになるため「パネル全体がフォーカスされている」表示になる。
テキストを shrink-wrap する input 風の focus 箱を作らない。

## owner 表示

repo 名の 2 行目に GitHub owner を出すのは展開時のみ。折りたたみ時に出さないのは意図的で、
常時 2 行はテキスト情報が煩雑になる一方、owner の区別は主に RepoIcon のアバターが担える。
アイコンだけでは owner 名の正確な文字列が分からないため、展開時のみテキストで補完する
という役割分担。

## ハイライト

active worktree を所有する repo は section 枠を薄い primary 線 + 浮き上がる影で示す
(`._fx-panel[data-active]`)。塗り / グローは持たせず、wt カードの border-primary + 外周
グローより弱くする。同じ青でも「枠線 (repo) < 枠線 + グロー (wt)」で主従が分かれ、wt
ハイライトが repo 枠に埋もれない。

## 開閉アニメーション

wt カード列の開閉は `<Transition>` で height 0 ↔ auto を CSS transition する
（`interpolate-size: allow-keywords` で auto が補間可能になる。Chromium 129+）。
transition root は padding を持たず height だけを補間し、padding は内側の div が持つ
（root が padding を持つと border-box でも h-0 時に padding 分の高さが残る）。
`overflow-hidden` は enter/leave の active class にだけ載せる。定常状態で clip すると
active wt カードの外周ブルーム（`_fx-quest-active` の box-shadow）が消えるため
（WtCard の「カード境界に overflow-hidden を使わない」規律と同根）。
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import type { Task, WorktreeEntry } from "@gozd/rpc";
import { computed, useTemplateRef } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { RepoIcon } from "../../../repo-icon";
import { useTerminalStore } from "../../../terminal";
import { WtCard } from "../worktree";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideGripVertical from "~icons/lucide/grip-vertical";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  rootDir: string;
  index: number;
  editMode: boolean;
  /** ✕ が「window から解除（PTY cleanup を伴う破壊的操作）」になるか。false なら
   * 「アクティブ repo list から外すだけ」。判定は SidebarPane の repoListsContaining */
  removesFromWindow: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  getFocusedPtyId: (dir: string) => number | undefined;
}>();

const emit = defineEmits<{
  removeRepo: [rootDir: string];
  selectRoot: [rootDir: string];
  selectWt: [wt: WorktreeEntry];
  selectTask: [wt: WorktreeEntry, task: Task];
  addWorktree: [rootDir: string];
  openWorktreeMenu: [anchorEl: HTMLElement, wt: WorktreeEntry, rootDir: string];
  openTaskMenu: [anchorEl: HTMLElement, task: Task, rootDir: string];
  openRepoMenu: [anchorEl: HTMLElement, rootDir: string];
}>();

const repoStore = useRepoStore();
const terminalStore = useTerminalStore();

const repo = computed(() => repoStore.repos[props.rootDir]);
const repoName = computed(() => repo.value?.repoName ?? props.rootDir);
const isGitRepo = computed(() => repo.value?.isGitRepo ?? false);
const collapsed = computed(() => repoStore.isCollapsed(props.rootDir));

const active = computed(() => repoStore.selectedRootDir === props.rootDir);

/** GitHub owner (org / 個人ユーザー)。取得は useSidebarData、SSOT は repoStore.githubIdentity。
 * undefined は解決中 (RepoIcon が空プレースホルダーを出す) */
const githubOwner = computed(() => repo.value?.githubIdentity?.owner);

const worktrees = computed(() => repo.value?.worktrees ?? []);

/**
 * main wt 先頭固定、その他は repoStore の worktrees 配列順を維持。
 * Claude state による並び替えは行わない (位置の安定性を優先)。
 */
const orderedWorktrees = computed(() => {
  const all = worktrees.value;
  const main = all.find((wt) => wt.isMain);
  const others = all.filter((wt) => !wt.isMain);
  return main !== undefined ? [main, ...others] : others;
});

/**
 * claude ビュー中は Claude セッションが動いている wt だけに絞る（SidebarPane の
 * repo フィルタと同じ規律）。編集モード中は全 section が collapse され wt カードが
 * 描画されないため、editMode の解除条件は不要。
 */
const claudeFilterActive = computed(() => terminalStore.viewMode === "claude");

const visibleWorktrees = computed(() => {
  if (!claudeFilterActive.value) return orderedWorktrees.value;
  return orderedWorktrees.value.filter((wt) => terminalStore.claudeActiveDirs.has(wt.path));
});

const sectionEl = useTemplateRef<HTMLElement>("section");
const dragHandleEl = useTemplateRef<HTMLElement>("dragHandle");

useSortable({
  id: computed(() => props.rootDir),
  index: computed(() => props.index),
  element: sectionEl,
  handle: dragHandleEl,
  disabled: computed(() => !props.editMode),
});

/**
 * claude ビューは「動いている agent の俯瞰」なので、対象 wt を持つ repo は collapse
 * 状態を無視して展開する。terminal のタイルは collapse と無関係に表示されるため、
 * 畳んだままだとタイルとサイドバーで見えている対象がずれる。
 * force-expand 中は折りたたみコントロール（ヘッダクリック / chevron）も抑止する。
 * 抑止しないと「クリックしても見た目は無反応だが永続 collapse 状態だけ反転する」
 * 隠れ副作用になり、wt ビューへ戻ったとき折りたたみが予期せずずれる。
 */
const forceExpanded = computed(
  () => !props.editMode && claudeFilterActive.value && visibleWorktrees.value.length > 0,
);

const visiblyCollapsed = computed(() => {
  if (props.editMode) return true;
  if (forceExpanded.value) return false;
  return collapsed.value;
});

// wt カード列が実際に展開表示されているか（非 git はカード列を持たないので常に false）
const bodyVisible = computed(() => isGitRepo.value && !visiblyCollapsed.value);

// owner 2 行目は展開時のみ表示（collapsed 時はヘッダを 1 行に保って一覧密度を優先する）。
// owner は 3 値（undefined = 解決中 / "" = GitHub owner なし。RepoIcon の <doc> 参照）で、
// どちらも空の 2 行目を出さない
const ownerVisible = computed(
  () => bodyVisible.value && githubOwner.value !== undefined && githubOwner.value !== "",
);

// テンプレートでネスト三項を書かず、ヘッダの aria はスクリプト側で導出する。
// git repo は折りたたみトグル (Expand/Collapse + aria-expanded)、非 git project は
// rootDir 選択ボタン (Open directory、折りたたみ概念なし) として振る舞う。
// ヘッダ button は通常モードでしか描画されないため editMode 分岐は持たない。
// aria-label はコンテンツ命名を上書きするため、動詞だけのラベルだと repo 名 / owner が
// スクリーンリーダーに伝わらない。可視表示と揃えて repo 識別子をラベルに含める
// （owner は 2 行目が見えている時だけ owner/name 形式にする）
const accessibleRepoName = computed(() =>
  ownerVisible.value ? `${githubOwner.value}/${repoName.value}` : repoName.value,
);
const headerAriaLabel = computed(() => {
  if (!isGitRepo.value) return `Open directory ${repoName.value}`;
  // force-expand 中はトグルが効かないので Collapse を予告せず、コンテンツ命名に任せる
  if (forceExpanded.value) return undefined;
  return `${visiblyCollapsed.value ? "Expand" : "Collapse"} ${accessibleRepoName.value}`;
});
// force-expand 中はヘッダが無反応になるため、disclosure widget としての
// aria-expanded も aria-label と対称に外す
const headerAriaExpanded = computed(() =>
  !isGitRepo.value || forceExpanded.value ? undefined : !visiblyCollapsed.value,
);

// ⋮ menu trigger。currentTarget (ボタン要素) を anchor として emit する (WtCard と同じ規約)。
function onOpenMenu(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openRepoMenu", target, props.rootDir);
}

// 通常モードのヘッダ button 専用（編集モードのヘッダは非インタラクティブな div）。
function onHeaderClick() {
  // 非 git project は worktree カードを持たず畳む対象が無いため、ヘッダクリックを
  // 「rootDir を active dir に選択」に振り分ける。これが非 git project のファイラーを
  // 表示する唯一の経路（git repo は WtCard クリックが担う）。
  if (!isGitRepo.value) {
    emit("selectRoot", props.rootDir);
    return;
  }
  // force-expand 中の toggle 抑止（理由は forceExpanded の docstring 参照）
  if (forceExpanded.value) return;
  repoStore.toggleCollapsed(props.rootDir);
}
</script>

<template>
  <!-- active repo ハイライト (_fx-panel[data-active]) は通常モード限定。編集モードは
       並び替え・除去の作業ビューなので選択状態の装飾を持ち込まない -->
  <section
    ref="section"
    :data-active="!editMode && active"
    class="_fx-panel mx-1 mb-2 flex flex-col rounded-lg"
  >
    <!-- 角丸は状態で変えず panel と同じ rounded-lg 固定。展開時に上下で radius が混在すると
         タブ状の歪な形に見えるため（full-bleed の設計原則は <doc> のレイアウト節を参照）。 -->
    <!-- header の中身は通常 / 編集で完全に分岐する（同一要素の使い回しをしない）。
         編集ヘッダは grip + 静的な名前 + ✕ だけで、_fx-shine の hover 演出もクリックも持たない。 -->
    <header
      class="group/repo relative flex items-center rounded-lg text-foreground"
      :class="!editMode && '_fx-shine'"
    >
      <!-- grip（drag handle）。ListRow と同じ分離理由は <doc> 参照。v-if ではなく v-show で
           両モードとも mount し続ける: 通常モードで handle ref が null になると、dnd-kit の
           Accessibility plugin が activator を element (section) に fallback して
           role="button" / tabindex="0" を注入し、section 内の任意クリックが ArcadeLayer の
           クリック音条件 ([role=button]) に合致してしまう。 -->
      <button
        v-show="editMode"
        ref="dragHandle"
        type="button"
        aria-label="Reorder repository"
        class="ml-1.5 grid size-6 shrink-0 cursor-grab place-items-center rounded-sm text-foreground-muted hover:bg-panel hover:text-foreground active:cursor-grabbing"
      >
        <IconLucideGripVertical class="size-3.5" />
      </button>
      <!-- 編集モード: 非インタラクティブな名前表示 + ✕。押せる要素は grip と ✕ だけ -->
      <template v-if="editMode">
        <div class="flex min-w-0 flex-1 items-center gap-2 p-2" :title="rootDir">
          <RepoIcon :name="repoName" :owner="githubOwner" />
          <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">
            {{ repoName }}
          </span>
        </div>
        <button
          type="button"
          :aria-label="
            removesFromWindow ? 'Remove repository from gozd' : 'Remove repository from list'
          "
          :title="removesFromWindow ? 'Remove from gozd' : 'Remove from list'"
          class="mr-1.5 grid size-6 place-items-center rounded-sm text-destructive-text hover:bg-destructive-subtle hover:text-destructive-text"
          @click.stop="emit('removeRepo', rootDir)"
        >
          <IconLucideX class="text-sm" />
        </button>
      </template>
      <!-- 通常モード: clickable 部はネイティブ button。focus / Enter / Space の起動はブラウザが
           扱うため tabindex / keydown を自前実装しない (WtCard と同じ規約)。 -->
      <template v-else>
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
          :title="rootDir"
          :aria-label="headerAriaLabel"
          :aria-expanded="headerAriaExpanded"
          @click="onHeaderClick"
        >
          <RepoIcon :name="repoName" :owner="githubOwner" />
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-sm font-semibold tracking-wide">{{ repoName }}</span>
            <span v-if="ownerVisible" class="truncate text-xs text-foreground-low">
              {{ githubOwner }}
            </span>
          </div>
        </button>
        <!-- 右側アクションクラスタ: 開閉 chevron + ⋮ menu を並べ、両方まとめて hover / focus-within で
             出す (WtCard の … と同一マテリアル)。absolute オーバーレイで flow から外すので icon / title を
             押さず、chevron 単独で右に浮くこともない。git repo 限定
             (非 git は折りたたみ対象が無く、復元も gozd 製 worktree 向けのため)。 -->
        <div
          v-if="isGitRepo"
          class="absolute inset-y-0 right-1.5 my-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-focus-within/repo:opacity-100 group-hover/repo:opacity-100"
        >
          <!-- chevron はヘッダ button と同一トグルの重複コントロールなので AT ツリーから外し、
               純粋な視覚アフォーダンスにする（残すと SR がヘッダ直後に repo 不明の
               「Expand」ボタンをもう 1 つ読み上げる）。命名 + aria-expanded はヘッダ button が担う -->
          <button
            v-if="!forceExpanded"
            type="button"
            aria-hidden="true"
            tabindex="-1"
            class="grid size-5 place-items-center rounded-sm bg-panel text-foreground shadow-md ring-1 ring-border hover:bg-element"
            @click.stop="repoStore.toggleCollapsed(rootDir)"
          >
            <IconLucideChevronDown
              class="size-3.5 text-foreground-muted transition-transform"
              :class="visiblyCollapsed && '-rotate-90'"
            />
          </button>
          <button
            type="button"
            :aria-label="`Open menu for ${accessibleRepoName}`"
            class="grid size-5 place-items-center rounded-sm bg-panel text-foreground shadow-md ring-1 ring-border hover:bg-element"
            @click="onOpenMenu"
          >
            <IconLucideEllipsisVertical class="text-xs" />
          </button>
        </div>
      </template>
    </header>

    <Transition
      enter-from-class="h-0"
      enter-active-class="overflow-hidden transition-[height] duration-200 ease-out motion-reduce:duration-0"
      leave-active-class="overflow-hidden transition-[height] duration-200 ease-out motion-reduce:duration-0"
      leave-to-class="h-0"
    >
      <div v-if="bodyVisible" class="[interpolate-size:allow-keywords]">
        <div class="flex flex-col gap-2 px-2 pt-1 pb-2">
          <WtCard
            v-for="wt in visibleWorktrees"
            :key="wt.path"
            :wt="wt"
            :root-dir="rootDir"
            :active="activeDir === wt.path"
            :focused-pty-id="getFocusedPtyId(wt.path)"
            @select-wt="emit('selectWt', $event)"
            @select-task="(w, t) => emit('selectTask', w, t)"
            @open-menu="(anchorEl, wt2) => emit('openWorktreeMenu', anchorEl, wt2, rootDir)"
            @open-task-menu="(anchorEl, t) => emit('openTaskMenu', anchorEl, t, rootDir)"
          />
          <button
            v-if="!claudeFilterActive"
            type="button"
            class="_fx-shine flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground-low transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground-muted disabled:hover:bg-transparent disabled:hover:text-foreground-muted"
            :disabled="isCreating"
            @click="emit('addWorktree', rootDir)"
          >
            <component
              :is="isCreating ? IconLucideLoaderCircle : IconLucidePlus"
              class="size-3.5"
              :class="isCreating ? 'animate-spin' : ''"
            />
            <span>New worktree</span>
          </button>
        </div>
      </div>
    </Transition>
  </section>
</template>
