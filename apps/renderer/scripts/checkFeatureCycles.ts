// dependency-cruiser を API で実行する lint gate（lint script が eslint に続けて呼ぶ）。
// CLI (depcruise) ではなく API を使うのは、設定を TypeScript (.dependency-cruiser.ts) の
// まま bun で第一級に読むため（CLI の TS 設定読み込みは Node の type stripping 頼み）。
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { allExtensions, cruise, format, getAvailableTranspilers } from "dependency-cruiser";
import extractTsConfig from "dependency-cruiser/config-utl/extract-ts-config";
import configuration from "../.dependency-cruiser";

const rendererRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(rendererRoot);

// fail-closed guard: 走査対象の拡張子は実行時のトランスパイラ解決
// (typescript / @vue/compiler-sfc が dependency-cruiser から require できるか) で決まり、
// 解決が外れた拡張子のファイルは黙って走査から消えて gate が全パスしてしまう。
// typescript は workspace で alias されており (pnpm-workspace.yaml)、supported range を
// 外れた瞬間に .ts が消える事故が起きうるため、必要な拡張子の可用性を先に検証する。
const REQUIRED_EXTENSIONS = [".ts", ".vue"];
const missing = REQUIRED_EXTENSIONS.filter(
  (ext) => !allExtensions.some((entry) => entry.extension === ext && entry.available),
);
if (missing.length > 0) {
  throw new Error(
    `dependency-cruiser cannot scan ${missing.join(", ")} — ` +
      `the graph would silently exclude those files. Available transpilers: ` +
      JSON.stringify(getAvailableTranspilers()),
  );
}

const tsConfig = extractTsConfig(fileURLToPath(new URL("../tsconfig.json", import.meta.url)));

const cruiseResult = await cruise(
  ["src/features"],
  {
    validate: true,
    ruleSet: { forbidden: configuration.forbidden },
    ...configuration.options,
  },
  undefined,
  { tsConfig },
);

// cruise はデフォルト reporter (json 相当) では ICruiseResult を返す。string は
// 別 reporter を明示したときの形なのでここでは契約違反として落とす
if (typeof cruiseResult.output === "string") {
  throw new Error("expected cruise() to return a structured ICruiseResult");
}

// 環境不整合 (transpiler 欠落等) は severity: warn のため exit code に乗らない。
// 成功時に握りつぶすと silent drop になるので常に表示する（正常時は空）
const environmentIssues = cruiseResult.output.summary.environment?.issues ?? [];
if (environmentIssues.length > 0) {
  console.error(`[checkFeatureCycles] environment issues: ${JSON.stringify(environmentIssues)}`);
}

// err-long は違反に rule の comment（解消の指針）を併記する
const report = await format(cruiseResult.output, { outputType: "err-long" });

if (report.exitCode > 0) {
  console.error(report.output);
  // 違反はフォルダ間エッジで報告されるため、そのエッジを作っている実 import を
  // 構造化結果から列挙する（どのファイルを直すべきかを grep なしで特定できるように）
  console.error("violating imports:");
  for (const violation of cruiseResult.output.summary.violations) {
    for (const module of cruiseResult.output.modules) {
      if (!module.source.startsWith(`${violation.from}/`)) continue;
      for (const dependency of module.dependencies) {
        // source / resolved は dependency-cruiser が posix 区切りで生成する識別子で
        // OS パスではないため、node:path の join へ置き換えない (リテラル "/" が正)。
        // folder エッジの to はライブラリ側で dirname(resolved) として決まる。
        // startsWith だと to の子孫フォルダへの import (エッジ非構成) まで拾ってしまう
        if (posix.dirname(dependency.resolved) === violation.to) {
          console.error(`  ${module.source} → ${dependency.resolved}`);
        }
      }
    }
  }
  process.exitCode = 1;
}
