/** ファイルの表示種別 */
export type FileType = "image" | "svg" | "markdown" | "html" | "code";

/**
 * 拡張子 → 表示種別 + MIME の対応表（SSOT）。mime は `<img>` 表示する種別
 * (image / svg) のみ持ち、ObjectURL の Blob type に使う。SVG は `image/svg+xml` を
 * 明示しないと `<img>` が描画しない（raster 画像は sniffing で表示できるが、型は常に明示する）。
 */
const EXTENSION_INFO: Record<string, { fileType: FileType; mime?: string }> = {
  png: { fileType: "image", mime: "image/png" },
  jpg: { fileType: "image", mime: "image/jpeg" },
  jpeg: { fileType: "image", mime: "image/jpeg" },
  gif: { fileType: "image", mime: "image/gif" },
  webp: { fileType: "image", mime: "image/webp" },
  avif: { fileType: "image", mime: "image/avif" },
  ico: { fileType: "image", mime: "image/x-icon" },
  bmp: { fileType: "image", mime: "image/bmp" },
  svg: { fileType: "svg", mime: "image/svg+xml" },
  md: { fileType: "markdown" },
  html: { fileType: "html" },
  htm: { fileType: "html" },
};

function extensionInfo(filePath: string): { fileType: FileType; mime?: string } | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_INFO[ext];
}

export function detectFileType(filePath: string): FileType {
  return extensionInfo(filePath)?.fileType ?? "code";
}

/** `<img>` 表示に使う MIME。image / svg 以外の拡張子は undefined */
export function imageMimeType(filePath: string): string | undefined {
  return extensionInfo(filePath)?.mime;
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
