interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
}

/** ディレクトリパスの末尾から表示名を抽出 */
function dirName(dirPath: string): string {
  const parts = dirPath.split("/");
  return parts[parts.length - 1] ?? dirPath;
}

/** ディレクトリ優先 → 名前順 */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export { dirName, sortEntries };
export type { FileEntry };
