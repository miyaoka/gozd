<doc lang="md">
marked で Markdown → HTML 変換し、DOMPurify でサニタイズして表示する。

- YAML frontmatter はコードブロックとして描画
- 相対パスリンクのクリックは worktree 相対パスとして解決し、プレビュー対象を切り替える
- http(s) / mailto: の絶対 URL は `openExternal` RPC で OS のデフォルトブラウザに渡す
  （分類と「委譲できない理由」の SSOT は `resolveMarkdownLink`）
- 行番号フラグメント (`./foo.ts#L42`) は lineNumber として `selectPath` に渡す
- 解決ロジックは `resolveMarkdownLink` に分離 (純粋関数 + ユニットテスト)
- 内部リンクの遷移は `useMarkdownHistoryStore.navigate()` 経由で行い、back / forward 履歴に積む。
  filer / terminal などの外部経路で selection が変わると履歴は破棄される (詳細は `useMarkdownHistoryStore` を参照)
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../../../shared/notification";
import { relDirOf } from "../../../filer";
import { normalizeAbsolute, normalizeRelative, useWorktreeStore } from "../../../worktree";
import { abortComposition, blockEdit } from "../../contenteditableHostGuard";
import { rpcOpenExternal } from "../../rpc";
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
 * - 分岐は `resolveMarkdownLink` の分類に従うだけ。passthrough (`#fragment` 単独) だけ
 *   preventDefault せず素通しし、external は openExternal RPC で撃つ
 *
 * VS Code の preview-src も http(s) は素通しするが、受け手はブラウザ既定の navigation ではなく
 * webview host (`webview/browser/pre/index.html` の handleInnerClick) で、そこが全リンククリックを
 * preventDefault して host へ転送している。gozd にこの層は無い。
 *
 * notification は **固定 message + 詳細を `cause` に分離** する。
 * `useNotificationStore` は同一 message を重複抑制するため、href 違いのリンクを連続
 * クリックしてもトーストが累積しない。href の生値は `cause` 側にだけ保持し、トースト
 * 詳細パネルで確認できる経路を残す。
 */
const ANCHOR_IGNORED_MESSAGE = "Heading anchors are not yet supported; opened the file only";
const LINK_INVALID_MESSAGE = "Could not open link from markdown preview";
const LINK_EXTERNAL_FAILED_MESSAGE = "Could not open link in the browser";

async function openExternal(url: string) {
  const opened = await tryCatch(rpcOpenExternal({ url }));
  if (opened.ok) return;
  // url は外側 Error の message に載せ、元 error は cause に包む。plain object に Error を
  // 入れると message / stack が non-enumerable のため詳細パネルで潰れる (formatCause 参照)
  notification.error(
    LINK_EXTERNAL_FAILED_MESSAGE,
    new Error(`url=${url}`, { cause: opened.error }),
  );
}

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

  if (resolved.kind === "external") {
    void openExternal(resolved.url);
    return;
  }

  if (resolved.kind === "invalid") {
    notification.error(LINK_INVALID_MESSAGE, { href, reason: resolved.reason });
    return;
  }

  if (resolved.droppedAnchor) {
    notification.info(ANCHOR_IGNORED_MESSAGE, { href });
  }
  markdownHistory.navigate(resolved.selection, resolved.lineNumber);
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
