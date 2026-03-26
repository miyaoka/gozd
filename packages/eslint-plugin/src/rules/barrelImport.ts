/**
 * スコープディレクトリ配下のモジュールはバレルファイル経由でのみ import 可能にする。
 *
 * - scope/X/ の内部ファイルを外部から直接 import するとエラー
 * - 同じ scope/X/ 内のファイルからは自由に import できる
 * - スコープディレクトリは再帰的にネスト可能（features/X/features/Y/）
 * - スコープ間の依存方向を制御可能（dependsOn で許可する依存先を宣言）
 */
import path from "node:path";

import type { Rule } from "eslint";

// ─── 型定義 ─────────────────────────────────────

interface ScopeConfig {
  directories: string[];
  dependsOn: string[];
  /** true の場合、同スコープ内でもモジュール間の import を禁止する */
  isolateModules?: boolean;
}

interface BarrelImportOptions {
  barrelFiles?: string[];
  scopes?: Record<string, ScopeConfig>;
}

// ─── デフォルト値 ───────────────────────────────

const DEFAULT_BARREL_FILES = ["index.ts", "index.tsx"];

const DEFAULT_SCOPES: Record<string, ScopeConfig> = {
  shared: { directories: ["shared"], dependsOn: [], isolateModules: true },
  features: { directories: ["features"], dependsOn: ["shared"] },
};

// ─── ユーティリティ ─────────────────────────────

/** Windows パス区切り文字を正規化する */
function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** 正規表現のメタ文字をエスケープする */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * スコープ設定からディレクトリ名のマッチ用正規表現を構築する。
 * 例: { shared: { directories: ["shared"] }, features: { directories: ["features"] } }
 *     → /(?:^|\/)((?:features|shared)\/[^/]+)(?:\/|$)/
 */
function buildScopePattern(scopes: Record<string, ScopeConfig>): RegExp {
  const allDirs = new Set<string>();
  for (const scope of Object.values(scopes)) {
    for (const dir of scope.directories) {
      allDirs.add(dir);
    }
  }
  // アルファベット順にソートして正規表現の決定性を保つ
  const dirPattern = [...allDirs]
    .sort()
    .map((d) => escapeRegExp(d))
    .join("|");
  return new RegExp(`(?:^|/)((?:${dirPattern})/[^/]+)(?:/|$)`);
}

/** スコープの識別情報 */
interface ScopeInfo {
  /** スコープのリーフペア（例: "features/common"）。ディレクトリ名やバレル判定に使用 */
  scope: string;
  /** パス先頭からスコープ末尾までのフルパス。同一性判定に使用 */
  fullPath: string;
}

/**
 * パス内の全スコープを浅い順に抽出する。
 * 例: "src/features/sidebar/features/worktree/WorktreeItem.vue"
 *     → [
 *         { scope: "features/sidebar", fullPath: "src/features/sidebar" },
 *         { scope: "features/worktree", fullPath: "src/features/sidebar/features/worktree" },
 *       ]
 *
 * fullPath により、異なる親の下にある同名子スコープを区別できる。
 */
function extractAllScopes(
  filePath: string,
  scopePattern: RegExp,
): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];
  let searchFrom = 0;
  while (searchFrom < filePath.length) {
    const remaining = filePath.slice(searchFrom);
    const match = scopePattern.exec(remaining);
    if (!match) break;
    const matchEnd = searchFrom + match.index + match[1].length;
    // match[0] の先頭が "/" の場合、match.index + 1 からスコープが始まる
    const scopeStart =
      match[0].startsWith("/") ? match.index + 1 : match.index;
    scopes.push({
      scope: match[1],
      fullPath: filePath.slice(0, searchFrom + scopeStart + match[1].length),
    });
    searchFrom += match.index + match[0].length;
  }
  return scopes;
}

/**
 * パスから最深スコープを抽出する。
 */
function extractDeepestScope(
  filePath: string,
  scopePattern: RegExp,
): ScopeInfo | undefined {
  const scopes = extractAllScopes(filePath, scopePattern);
  return scopes[scopes.length - 1];
}

/**
 * スコープ文字列（"features/sidebar"）からディレクトリ名部分（"features"）を取得する。
 */
function getScopeDir(scope: string): string {
  return scope.split("/")[0];
}

/**
 * import 先が許可されたスコープのバレルファイルを指しているかを判定する。
 *
 * - 拡張子付き: barrelFiles に含まれ、かつ直前のセグメントがスコープ名と一致
 * - 拡張子なし: 最後のセグメントがスコープ名と一致（ディレクトリ import → index 暗黙解決）
 */
function isBarrelImport(
  importSource: string,
  allowedScope: string,
  barrelFiles: string[],
): boolean {
  const segments = importSource.split("/");
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return false;

  const scopeDirName = allowedScope.split("/").pop();

  // 拡張子付き: barrelFiles に含まれ、かつ直前のセグメントがスコープ名と一致
  if (lastSegment.includes(".")) {
    if (!barrelFiles.includes(lastSegment)) return false;
    const parentSegment = segments[segments.length - 2];
    return parentSegment === scopeDirName;
  }

  // 拡張子なし: スコープのディレクトリ名と一致すればディレクトリ import（index 暗黙解決）
  return lastSegment === scopeDirName;
}

/**
 * import 元のスコープから import 先のスコープへの依存が許可されているかを判定する。
 * dependsOn に含まれていなければ禁止。
 */
function isDependencyAllowed(
  fromScopeDir: string,
  toScopeDir: string,
  scopes: Record<string, ScopeConfig>,
  dirToScope: Map<string, string>,
): boolean {
  // 同じスコープディレクトリ同士は常に許可
  if (fromScopeDir === toScopeDir) return true;

  const fromScopeName = dirToScope.get(fromScopeDir);
  const toScopeName = dirToScope.get(toScopeDir);
  if (!fromScopeName || !toScopeName) return true;

  // 同じスコープ名に属する異なるディレクトリ同士は許可
  if (fromScopeName === toScopeName) return true;

  return scopes[fromScopeName].dependsOn.includes(toScopeName);
}

// ─── ルール定義 ─────────────────────────────────

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "スコープディレクトリ配下のモジュールはバレルファイル経由でのみ import 可能",
    },
    messages: {
      noDirectImport:
        "'{{importSource}}' の直接 import は禁止されています。'{{scopeName}}' のバレルファイル経由で import してください。",
      noDependency:
        "'{{fromScope}}' から '{{toScope}}' への依存は禁止されています。",
      noCrossModuleDependency:
        "'{{scopeName}}' スコープはモジュール間の依存が禁止されています（isolateModules）。",
      invalidConfig:
        "barrel-import: {{detail}}",
    },
    schema: [
      {
        type: "object",
        properties: {
          barrelFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "拡張子付き import でバレルとして許可するファイル名のリスト。拡張子なしのディレクトリ import は常に許可される（デフォルト: [\"index.ts\", \"index.tsx\"]）",
          },
          scopes: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                directories: {
                  type: "array",
                  items: { type: "string" },
                  description: "このスコープに属するディレクトリ名のリスト",
                },
                dependsOn: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "このスコープが依存できるスコープ名のリスト。未記載のスコープへの依存は禁止",
                },
                isolateModules: {
                  type: "boolean",
                  description:
                    "true の場合、同スコープ内でもモジュール間の import を禁止する",
                },
              },
              required: ["directories", "dependsOn"],
              additionalProperties: false,
            },
            description:
              "スコープの定義。キーはスコープ名、directories でディレクトリ名を指定、dependsOn で依存可能なスコープを宣言",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] as BarrelImportOptions | undefined;
    const barrelFiles = options?.barrelFiles ?? DEFAULT_BARREL_FILES;
    const scopes = options?.scopes ?? DEFAULT_SCOPES;

    // ─── scopes バリデーション ───────────────────
    const scopeNames = Object.keys(scopes);
    if (scopeNames.length === 0) {
      context.report({
        loc: { line: 1, column: 0 },
        messageId: "invalidConfig",
        data: { detail: "scopes は空にできません" },
      });
      return {};
    }

    const dirToScope = new Map<string, string>();
    for (const [scopeName, config] of Object.entries(scopes)) {
      if (config.directories.length === 0) {
        context.report({
          loc: { line: 1, column: 0 },
          messageId: "invalidConfig",
          data: {
            detail: `scopes.${scopeName}.directories は空にできません`,
          },
        });
        return {};
      }
      for (const dir of config.directories) {
        const existing = dirToScope.get(dir);
        if (existing) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "invalidConfig",
            data: {
              detail: `ディレクトリ '${dir}' がスコープ '${existing}' と '${scopeName}' で重複しています`,
            },
          });
          return {};
        }
        dirToScope.set(dir, scopeName);
      }
      for (const dep of config.dependsOn) {
        if (!scopeNames.includes(dep)) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "invalidConfig",
            data: {
              detail: `scopes.${scopeName}.dependsOn に未定義のスコープ '${dep}' が含まれています`,
            },
          });
          return {};
        }
      }
    }

    const scopePattern = buildScopePattern(scopes);
    const filename = normalizePath(context.filename);

    function check(sourceNode: Rule.Node, importSource: string) {
      // 外部パッケージ（相対パスでない）はスキップ
      if (!importSource.startsWith(".")) return;

      // import 先の絶対パスを解決
      const resolvedPath = normalizePath(
        path.resolve(path.dirname(filename), importSource),
      );

      // import 先の全スコープを抽出（浅い順）
      const toScopeInfos = extractAllScopes(resolvedPath, scopePattern);
      if (toScopeInfos.length === 0) return;

      const toDeepest = toScopeInfos[toScopeInfos.length - 1]; // 最深スコープ
      const toRoot = toScopeInfos[0]; // 最浅スコープ（外部から見える境界）

      // スコープ間の依存方向チェック
      const fromScopeInfos = extractAllScopes(filename, scopePattern);
      if (fromScopeInfos.length > 0) {
        const fromRootDir = getScopeDir(fromScopeInfos[0].scope);
        const toRootDir = getScopeDir(toRoot.scope);
        if (
          !isDependencyAllowed(fromRootDir, toRootDir, scopes, dirToScope)
        ) {
          const fromScopeName = dirToScope.get(fromRootDir) ?? fromRootDir;
          const toScopeName = dirToScope.get(toRootDir) ?? toRootDir;
          context.report({
            node: sourceNode,
            messageId: "noDependency",
            data: {
              fromScope: fromScopeName,
              toScope: toScopeName,
            },
          });
          return;
        }
      }

      // import 元の最深スコープを抽出
      const fromDeepest = extractDeepestScope(filename, scopePattern);

      // 同じスコープ内のファイル同士は自由（fullPath で比較し、同名子スコープを区別）
      if (fromDeepest && fromDeepest.fullPath === toDeepest.fullPath) return;

      // isolateModules: 同スコープ内でもモジュール間の import を禁止
      if (fromDeepest && fromDeepest.fullPath !== toDeepest.fullPath) {
        const fromScopeDir = getScopeDir(fromDeepest.scope);
        const toScopeDir = getScopeDir(toDeepest.scope);
        if (fromScopeDir === toScopeDir) {
          const scopeName = dirToScope.get(fromScopeDir);
          if (scopeName && scopes[scopeName].isolateModules) {
            context.report({
              node: sourceNode,
              messageId: "noCrossModuleDependency",
              data: { scopeName },
            });
            return;
          }
        }
      }

      // 子スコープから親スコープの内部ファイルへのアクセスは自由
      // import 元のパスに to のスコープの fullPath が含まれている = to は from の祖先スコープ
      if (
        fromDeepest &&
        fromDeepest.fullPath !== toDeepest.fullPath &&
        filename.includes(`${toDeepest.fullPath}/`)
      )
        return;

      // import 元がルートスコープの内部にいるか判定
      // 内部 = import 元自身がルートスコープ、またはルートスコープの子孫
      const isInsideRootScope =
        (fromDeepest && fromDeepest.fullPath === toRoot.fullPath) ||
        filename.includes(`${toRoot.fullPath}/`);

      // バレル経由のチェック
      // 内部にいる → 子スコープのバレル（最深スコープ）経由ならOK
      // 外部にいる → ルートスコープのバレルのみOK（子スコープは親の内部実装）
      const allowedScope = isInsideRootScope
        ? toDeepest.scope
        : toRoot.scope;
      if (isBarrelImport(importSource, allowedScope, barrelFiles)) return;

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
