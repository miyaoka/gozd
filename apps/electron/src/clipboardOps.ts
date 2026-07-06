// OS クリップボードへのファイル参照書き込み（macOS 専用）。
//
// Electron の clipboard には「ファイルをコピーする」高水準 API が無いため、
// macOS pasteboard の NSFilenamesPboardType（ファイルパス配列の plist XML）を
// writeBuffer で直接書く。これで Finder / Slack 等へのファイル paste が成立する。
// テキスト形式（path 文字列）と違い、貼り付け先にはファイル実体が渡る。

import { clipboard } from "electron";

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (char) => XML_ESCAPES[char]);
}

export function writeFilesToClipboard(paths: string[]): void {
  if (paths.length === 0) {
    throw new Error("paths is empty");
  }
  const items = paths.map((p) => `<string>${escapeXml(p)}</string>`).join("");
  const plist = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><array>${items}</array></plist>`,
  ].join("");
  clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist));
}
