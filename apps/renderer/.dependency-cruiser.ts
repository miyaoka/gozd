// feature 間依存の循環禁止 (CLAUDE.md「feature 間の依存」)。
//
// scope: "folder" は module を全祖先フォルダへ集約したフォルダ粒度のグラフで循環を
// 判定する。包含関係にあるフォルダ間（feature とその子 feature）は原理的に循環に
// ならないため、対象は互いに包含しない feature / 子 feature どうしのエッジになる。
// テストファイルも同じ feature の一部としてグラフに含める（テストの依存も feature の依存）。
//
// shared 側の規律（shared → feature 禁止 / shared 間禁止）は ESLint の barrel-import が
// 担う。feature 層が DAG であれば renderer 全体の依存グラフもフォルダ粒度で DAG になる
// （同一 feature 内のファイル粒度の循環は本ルールの対象外）。
import type { IConfiguration } from "dependency-cruiser";

const configuration: IConfiguration = {
  forbidden: [
    {
      name: "no-feature-cycles",
      // comment は違反エラーに表示される。読者はこのファイルではなくエラー出力で読む
      comment:
        "feature 間の依存は DAG。循環上の全エッジが報告されるが、直すのは 1 エッジ (通常は今足したもの): " +
        "共有概念を下層 (shared / 下位 feature) へ抽出する、依存を逆転する (下層は状態やイベントの公開だけにし上層が結線する)、" +
        "composition root (App.vue / MainLayout) で合成する、のいずれかで解消する",
      severity: "error",
      scope: "folder",
      from: { path: "^src/features" },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // import type を依存として数える（型の循環も禁止する規約のため）
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};

export default configuration;
