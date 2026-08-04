// HTML preview の配信 scheme 名。
//
// 配信の実装 (previewProtocol.ts) は electron に依存するが、navigation 防壁の判定
// (urlPolicy.ts) は純関数として bun test から呼ぶ。両者が同じ scheme を指すための SSOT を
// electron 非依存の位置に置く。
export const PREVIEW_SCHEME = "gozd-preview";
