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
 * パス内の全スコープを浅い順に抽出する。
 * 例: "src/features/sidebar/features/worktree/WorktreeItem.vue"
 *     → ["features/sidebar", "features/worktree"]
 */
function extractAllScopes(filePath: string): string[] {
  const scopes: string[] = [];
  let searchFrom = 0;
  while (searchFrom < filePath.length) {
    const remaining = filePath.slice(searchFrom);
    const match = SCOPE_PATTERN.exec(remaining);
    if (!match) break;
    scopes.push(match[1]);
    searchFrom += match.index + match[0].length;
  }
  return scopes;
}

/**
 * import 先の resolved path から最深スコープを抽出する。
 * 例: "src/features/terminal/useTerminalStore.ts" → "features/terminal"
 * 例: "src/features/sidebar/features/worktree/WorktreeItem.vue" → "features/worktree"
 */
function extractScope(filePath: string): string | undefined {
  const scopes = extractAllScopes(filePath);
  return scopes[scopes.length - 1];
}

/**
 * import 先が許可されたスコープのバレルファイル（index.ts）を指しているかを判定する。
 *
 * - 拡張子付き: index.ts かつ直前のセグメントがスコープ名と一致
 * - 拡張子なし: 最後のセグメントがスコープ名と一致（ディレクトリ import → index.ts 暗黙解決）
 */
function isBarrelImport(importSource: string, allowedScope: string): boolean {
  const segments = importSource.split("/");
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return false;

  const scopeDirName = allowedScope.split("/").pop();

  // 拡張子付き: index.ts かつ直前のセグメントがスコープ名と一致
  // （index.vue 等はバレルではない）
  if (lastSegment.includes(".")) {
    if (lastSegment !== "index.ts") return false;
    const parentSegment = segments[segments.length - 2];
    return parentSegment === scopeDirName;
  }

  // 拡張子なし: スコープのディレクトリ名と一致すればディレクトリ import（index 暗黙解決）
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

      // import 先の全スコープを抽出（浅い順）
      const toScopes = extractAllScopes(resolvedPath);
      if (toScopes.length === 0) return;

      const toScope = toScopes[toScopes.length - 1]; // 最深スコープ
      const toRootScope = toScopes[0]; // 最浅スコープ（外部から見える境界）

      // shared → features の依存チェック
      if (isInSharedScope(filename) && isInFeaturesScope(resolvedPath)) {
        context.report({
          node: sourceNode,
          messageId: "noSharedToFeature",
        });
        return;
      }

      // import 元の最深スコープを抽出
      const fromScope = extractScope(filename);

      // 同じスコープ内のファイル同士は自由
      if (fromScope === toScope) return;

      // 子 feature から親スコープの内部ファイルへのアクセスは自由
      // import 元のパスに to のスコープが含まれている = to は from の祖先スコープ
      if (fromScope && fromScope !== toScope && filename.includes(`/${toScope}/`)) return;

      // import 元がルートスコープの内部にいるか判定
      // 内部 = import 元自身がルートスコープ、またはルートスコープの子孫
      const isInsideRootScope =
        fromScope === toRootScope || filename.includes(`/${toRootScope}/`);

      // バレル経由のチェック
      // 内部にいる → 子 feature のバレル（最深スコープ）経由ならOK
      // 外部にいる → ルートスコープのバレルのみOK（子 feature は親の内部実装）
      const allowedScope = isInsideRootScope ? toScope : toRootScope;
      if (isBarrelImport(importSource, allowedScope)) return;

      // それ以外は禁止
      context.report({
        node: sourceNode,
        messageId: "noDirectImport",
        data: {
          importSource,
          scopeName: allowedScope,
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
