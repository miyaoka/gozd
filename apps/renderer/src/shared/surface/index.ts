// サーフェスの開閉 (showSurface / hideSurface) と前面化 (raiseSurface) は公開しない。
// 外から呼べると「必ず本モジュールを通す」規律が doc 頼みになるため、配線は useSurface に閉じる。
export {
  closeFocusedSurface,
  hasFocusedSurface,
  pinSurface,
  unpinSurface,
} from "./topLayerSurface";
export { useSurface } from "./useSurface";
