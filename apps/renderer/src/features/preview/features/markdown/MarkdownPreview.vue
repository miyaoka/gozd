<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
  （http(s) / mailto: 等の絶対 URL は `ExternalLinkNavigationDecider` 経路で外部ブラウザに渡す）
- 行番号フラグメント (`./foo.ts#L42`) は lineNumber として `selectPath` に渡す
- 解決ロジックは `resolveMarkdownLink` に分離 (純粋関数 + ユニットテスト)
- 内部リンクの遷移は `useMarkdownHistoryStore.navigate()` 経由で行い、back / forward 履歴に積む。
  filer / terminal などの外部経路で selection が変わると履歴は破棄される (詳細は `useMarkdownHistoryStore` を参照)
</doc>

<script setup lang="ts">
import { useNotificationStore } from "../../../../shared/notification";
import { relDirOf } from "../../../filer";
import { normalizeAbsolute, normalizeRelative, useWorktreeStore } from "../../../worktree";
import MarkdownBody from "./MarkdownBody.vue";
import { resolveMarkdownLink } from "./resolveMarkdownLink";
import { useMarkdownHistoryStore } from "./useMarkdownHistoryStore";

defineProps<{
  content: string;
}>();

const worktreeStore = useWorktreeStore();
const markdownHistory = useMarkdownHistoryStore();
const notification = useNotificationStore();

/**
 * クリック経路は VS Code (`markdown-language-features/preview-src/index.ts`) に揃える。
 * - 左クリックの `@click` のみ。middle click (`auxclick`) は WebView の既定挙動に任せる
 *   (VS Code でも未対応 / 内部リンクとして扱わない)
 * - scheme 付き URL と `#fragment` 単独は preventDefault せず素通しし、
 *   `ExternalLinkNavigationDecider` (外部 URL) / ブラウザ既定スクロール (`#`) に委ねる
 *
 * notification は **固定 message + 詳細を `cause` に分離** する。
 * `useNotificationStore` は同一 message を重複抑制するため、href 違いのリンクを連続
 * クリックしてもトーストが累積しない。href の生値は `cause` 側にだけ保持し、トースト
 * 詳細パネルで確認できる経路を残す。
 */
const ANCHOR_IGNORED_MESSAGE = "Heading anchors are not yet supported; opened the file only";
const LINK_INVALID_MESSAGE = "Could not open link from markdown preview";

function onLinkClick(e: MouseEvent) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.closest("a");
  if (anchor === null) return;
  const href = anchor.getAttribute("href");
  if (href === null) return;

  const resolved = resolveMarkdownLink({
    href,
    basePath: worktreeStore.selection,
    relDirOf,
    normalizeRelative,
    normalizeAbsolute,
  });

  if (resolved.kind === "passthrough") return;

  e.preventDefault();

  if (resolved.kind === "invalid") {
    notification.error(LINK_INVALID_MESSAGE, { href, reason: resolved.reason });
    return;
  }

  if (resolved.droppedAnchor) {
    notification.info(ANCHOR_IGNORED_MESSAGE, { href });
  }
  markdownHistory.navigate(resolved.selection, resolved.lineNumber);
}

/**
 * contenteditable host の編集経路を構造的にブロックする。`beforeinput` で
 * `event.preventDefault()` すれば typing / paste / undo-redo / drop の DOM mutation を
 * 1 経路で止められる (input 系全部の上位 hook)。
 *
 * 例外は IME: composition 由来の `beforeinput` (`insertCompositionText`) は Input Events
 * 仕様で cancelable: false のため preventDefault が no-op になり、変換中テキストが DOM に
 * 挿入されてしまう。IME 経路は `abortComposition` (`@compositionstart`) 側で塞ぐ。
 *
 * テンプレート側では各 contenteditable host に `@beforeinput="blockEdit"` に加えて
 * `@dragover.prevent @drop.prevent` も付けている。`beforeinput` だけでも drop の DOM mutation
 * は弾けるが、`dragover` を preventDefault しないと UA がドロップ可能 cursor / drop indicator を
 * 一瞬表示してチラ見せが起きる経路があり、UX 上の保険として両方つける契約。
 *
 * Cmd+A / Cmd+C は `beforeinput` を発火させない (input ではない)。コピーは UA 既定が動き、
 * Cmd+A はスコープが contenteditable subtree に閉じる。これらに別途 handler は不要。
 */
function blockEdit(event: Event) {
  event.preventDefault();
}

/**
 * IME composition を入口で中断する (`blockEdit` の IME 例外の受け皿)。composition 開始と
 * 同時に host を non-editable にすると Chromium が composition を abort し、cancelable: false
 * の `insertCompositionText` が DOM に到達しない。次フレームで editable に戻して
 * Cmd+A スコープ / 選択コピーの契約を維持する (template の contenteditable は静的属性で
 * Vue は再描画時に復元しないため、自前で戻す)。
 */
function abortComposition(event: CompositionEvent) {
  const host = event.currentTarget;
  if (!(host instanceof HTMLElement)) return;
  host.contentEditable = "false";
  requestAnimationFrame(() => {
    host.contentEditable = "true";
  });
}
</script>

<template>
  <MarkdownBody
    class="p-6 text-sm/relaxed"
    contenteditable="true"
    spellcheck="false"
    autocorrect="off"
    autocapitalize="off"
    role="region"
    aria-label="Markdown contents"
    :content="content"
    @link-click="onLinkClick"
    @beforeinput="blockEdit"
    @compositionstart="abortComposition"
    @dragover.prevent
    @drop.prevent
  />
</template>
