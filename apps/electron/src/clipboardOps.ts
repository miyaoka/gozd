// OS クリップボードへのファイル参照書き込み。
//
// `text/uri-list` は OS ネイティブの「コピーされたファイル」形式（macOS では NSFilenamesPboardType）
// へマップされ、Finder / Slack 等へのファイル paste を成立させる。テキスト形式（path 文字列）と
// 違い、貼り付け先にはファイル実体が渡る。

import { ClipboardItem, clipboard } from "electron";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function writeFilesToClipboard(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    throw new Error("paths is empty");
  }
  // 存在しないパス（git status D の削除済みファイル等）を書くと、クリップボード書き込み自体は
  // 成功して "Copied" 通知が出るのに paste 先では何も得られない dangling reference になる。
  // false-success を作らないため実体の存在を検証して throw する（renderer 側で error toast になる）
  for (const p of paths) {
    if (!existsSync(p)) {
      throw new Error(`file not found: ${p}`);
    }
  }
  // RFC 2483 の URI list。1 行 1 URI で CRLF 区切り
  const uriList = paths.map((p) => pathToFileURL(p).href).join("\r\n");
  await clipboard.write([new ClipboardItem({ "text/uri-list": uriList })]);
}
