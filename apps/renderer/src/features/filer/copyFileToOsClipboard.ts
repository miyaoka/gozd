/**
 * ファイルを OS クリップボードに「ファイル参照」として書き、結果を toast で通知する。
 *
 * テキストの path copy（FileContextMenu の Copy path）とは別物で、Finder / Slack 等の
 * 他アプリへファイルそのものを paste できる。クリップボードは視覚的な状態を持たないため、
 * 成功時も必ず toast を出してユーザーの認識（コピーした）と実状態を一致させる。
 */
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { rpcClipboardCopyFiles } from "./rpc";

export async function copyFileToOsClipboard(absPath: string, displayName: string): Promise<void> {
  const notify = useNotificationStore();
  const result = await tryCatch(rpcClipboardCopyFiles({ paths: [absPath] }));
  if (!result.ok) {
    notify.error("Failed to copy file", result.error);
    return;
  }
  notify.info(`Copied ${displayName}`);
}
