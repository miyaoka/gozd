import type { FunctionalComponent, SVGAttributes } from "vue";

/**
 * `~icons/*` (unplugin-icons の virtual module) の stub。
 *
 * 実体は Vite build 時に unplugin-icons が解決するため実ファイルが存在せず、
 * Vite を経由しない `bun test` ではモジュール解決に失敗する。Bun は tsconfig の
 * `paths` を runtime 解決に使うので、`~icons/*` をこのファイルへマップして
 * テスト時は空の functional component に倒す (icon は表示専用でロジックに関与しない)。
 *
 * 型は実物 (unplugin-icons/types/vue) と同じ `FunctionalComponent<SVGAttributes>` を
 * 公開するため、vue-tsc が paths 経由でここへ解決しても型検査は等価。
 * Vite は tsconfig paths を読まないので build には影響しない。
 */
const iconStub: FunctionalComponent<SVGAttributes> = () => null;

export default iconStub;
