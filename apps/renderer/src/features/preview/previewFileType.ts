/** ファイルの表示種別 */
export type FileType = "image" | "svg" | "markdown" | "html" | "code";

const FILE_TYPE_EXTENSIONS: Record<string, FileType> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  svg: "svg",
  md: "markdown",
  html: "html",
  htm: "html",
};

export function detectFileType(filePath: string): FileType {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPE_EXTENSIONS[ext] ?? "code";
}

/** rendered 表示を持つファイル種別か */
export function hasRenderedView(ft: FileType): boolean {
  return ft === "svg" || ft === "markdown" || ft === "image" || ft === "html";
}

/**
 * ファイル選択時に rendered / source のどちらをデフォルト表示にするか。
 * HTML は「ソースを読む」用途が主で、レンダリング描画は明示的なトグルに倒す。
 * markdown / svg / image はレンダリング表示がデフォルト。
 */
export function defaultPreviewEnabled(ft: FileType): boolean {
  return ft !== "html";
}
