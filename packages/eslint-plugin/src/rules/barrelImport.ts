/**
 * features/ や shared/ 配下のモジュールは index.ts（バレルファイル）経由でのみ import 可能にする。
 *
 * - features/X/ の内部ファイルを外部から直接 import するとエラー
 * - 同じ features/X/ 内のファイルからは自由に import できる
 * - features/ は再帰的にネスト可能（features/X/features/Y/）
 * - shared/ も同じルールに従う
 * - shared/ から features/ への依存は禁止
 */
import path from "node:path";

import type { Rule } from "eslint";

/** Windows パス区切り文字を正規化する */
function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** features/ または shared/ セグメントの直後のディレクトリ名までをスコープとして抽出する */
const SCOPE_PATTERN = /(?:^|\/)((?:features|shared)\/[^/]+)(?:\/|$)/;

/**
 * import 先の resolved path からスコープを抽出する。
 * 例: "src/features/terminal/useTerminalStore.ts" → "features/terminal"
 * 例: "src/features/sidebar/features/worktree/WorktreeItem.vue" → "features/worktree"
 *     （最も深い features/ セグメントにマッチ）
 */
function extractScope(filePath: string): string | undefined {
  // 最後にマッチしたスコープを返す（最も深いネストを優先）
  let lastMatch: string | undefined;
  let searchFrom = 0;
  while (searchFrom < filePath.length) {
    const remaining = filePath.slice(searchFrom);
    const match = SCOPE_PATTERN.exec(remaining);
    if (!match) break;
    lastMatch = match[1];
    searchFrom += match.index + match[0].length;
  }
  return lastMatch;
}

/**
 * import 先が index ファイルかどうかを判定する。
 * 拡張子なし（"../terminal"）の場合は index.ts が暗黙解決されるので OK。
 */
/**
 * import 先がバレルファイル（index.ts）を指しているかを判定する。
 *
 * 拡張子なし import の場合:
 * - import source の最後のセグメントがスコープ名と一致 → ディレクトリ import（index.ts 暗黙解決）
 * - それ以外 → ファイルへの直接 import
 */
function isBarrelImport(importSource: string, toScope: string): boolean {
  const lastSegment = importSource.split("/").pop();
  if (!lastSegment) return false;

  // 拡張子付きなら index.ts かどうか（index.vue 等はバレルではない）
  if (lastSegment.includes(".")) {
    return lastSegment === "index.ts";
  }

  // 拡張子なし: スコープのディレクトリ名と一致すればディレクトリ import（index 暗黙解決）
  const scopeDirName = toScope.split("/").pop();
  return lastSegment === scopeDirName;
}

/**
 * ファイルパスが shared/ スコープに属するかどうかを判定する。
 */
function isInSharedScope(filePath: string): boolean {
  return /(?:^|\/)shared\//.test(filePath);
}

/**
 * ファイルパスが features/ スコープに属するかどうかを判定する。
 */
function isInFeaturesScope(filePath: string): boolean {
  return /(?:^|\/)features\//.test(filePath);
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "features/ や shared/ 配下のモジュールはバレルファイル（index.ts）経由でのみ import 可能",
    },
    messages: {
      noDirectImport:
        "'{{importSource}}' の直接 import は禁止されています。'{{scopeName}}' のバレルファイル（index.ts）経由で import してください。",
      noSharedToFeature:
        "shared/ から features/ への依存は禁止されています。",
    },
    schema: [],
  },
  create(context) {
    const filename = normalizePath(context.filename);

    function check(sourceNode: Rule.Node, importSource: string) {
      // 外部パッケージ（相対パスでない）はスキップ
      if (!importSource.startsWith(".")) return;

      // import 先の絶対パスを解決
      const resolvedPath = normalizePath(
        path.resolve(path.dirname(filename), importSource),
      );

      // import 先のスコープを抽出
      const toScope = extractScope(resolvedPath);
      if (!toScope) return;

      // shared → features の依存チェック
      if (isInSharedScope(filename) && isInFeaturesScope(resolvedPath)) {
        context.report({
          node: sourceNode,
          messageId: "noSharedToFeature",
        });
        return;
      }

      // import 元のスコープを抽出
      const fromScope = extractScope(filename);

      // 同じスコープ内のファイル同士は自由
      if (fromScope === toScope) return;

      // 子 feature から親スコープの内部ファイルへのアクセスは自由
      // import 元のパスに to のスコープが含まれている = to は from の祖先スコープ
      if (fromScope && fromScope !== toScope && filename.includes(`/${toScope}/`)) return;

      // バレル（index.ts）経由ならOK
      if (isBarrelImport(importSource, toScope)) return;

      // それ以外は禁止
      context.report({
        node: sourceNode,
        messageId: "noDirectImport",
        data: {
          importSource,
          scopeName: toScope,
        },
      });
    }

    return {
      ImportDeclaration(node) {
        check(node, String(node.source.value));
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          check(node, String(node.source.value));
        }
      },
      ExportAllDeclaration(node) {
        check(node, String(node.source.value));
      },
    };
  },
};

export default rule;
