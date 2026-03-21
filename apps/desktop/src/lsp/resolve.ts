import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tryCatch } from "@gozd/shared";

/** プロジェクトの node_modules から tsgo ネイティブバイナリを探す */
export async function resolveTsgoPath(projectDir: string): Promise<string | undefined> {
  const packageName = `@typescript/native-preview-${process.platform}-${process.arch}`;

  // 直接パス（npm / yarn hoisted）
  const directPath = path.join(projectDir, "node_modules", packageName, "lib", "tsgo");
  if (fs.existsSync(directPath)) return directPath;

  // pnpm .pnpm 配下
  const pnpmBase = path.join(projectDir, "node_modules", ".pnpm");
  const prefix = `@typescript+native-preview-${process.platform}-${process.arch}@`;
  const entriesResult = await tryCatch(fsp.readdir(pnpmBase));
  if (entriesResult.ok) {
    for (const entry of entriesResult.value) {
      if (entry.startsWith(prefix)) {
        const candidate = path.join(pnpmBase, entry, "node_modules", packageName, "lib", "tsgo");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  return undefined;
}

/**
 * vue-language-server のエントリポイントと tsdk パスを探す。
 * pnpm モノレポでは .pnpm はルートの node_modules にのみ存在する。
 */
export interface VueLspPaths {
  serverPath: string;
  tsdkPath: string;
  /** @vue/typescript-plugin の親 node_modules ディレクトリ（tsserver --pluginProbeLocations 用） */
  pluginProbeLocation: string;
}

export function resolveVueLspPaths(
  projectRoot: string,
  packageDir: string,
): VueLspPaths | undefined {
  const prefix = "@vue+language-server@";

  // pnpm: ルートの node_modules/.pnpm から探す
  const pnpmBase = path.join(projectRoot, "node_modules", ".pnpm");
  console.log(`[lsp:vue/resolve] pnpmBase: ${pnpmBase}`);

  let serverPath: string | undefined;

  const entriesResult = tryCatch(() => fs.readdirSync(pnpmBase));
  if (entriesResult.ok) {
    const matchingEntries = entriesResult.value.filter((e) => e.startsWith(prefix));
    console.log(`[lsp:vue/resolve] matching entries: ${matchingEntries.join(", ") || "(none)"}`);

    for (const entry of matchingEntries) {
      const candidate = path.join(
        pnpmBase,
        entry,
        "node_modules",
        "@vue",
        "language-server",
        "bin",
        "vue-language-server.js",
      );
      if (fs.existsSync(candidate)) {
        serverPath = candidate;
        break;
      }
    }
  }

  // パッケージの node_modules から直接探す（hoisted の場合）
  if (!serverPath) {
    const directPath = path.join(
      packageDir,
      "node_modules",
      "@vue",
      "language-server",
      "bin",
      "vue-language-server.js",
    );
    console.log(`[lsp:vue/resolve] direct: ${directPath}, exists: ${fs.existsSync(directPath)}`);
    if (fs.existsSync(directPath)) {
      serverPath = directPath;
    }
  }

  if (!serverPath) {
    console.log("[lsp:vue/resolve] server not found");
    return undefined;
  }
  console.log(`[lsp:vue/resolve] serverPath: ${serverPath}`);

  // tsdk パス（typescript/lib ディレクトリ）— パッケージの node_modules から探す
  const tsdkPath = path.join(packageDir, "node_modules", "typescript", "lib");
  const tsdkExists = fs.existsSync(path.join(tsdkPath, "typescript.js"));
  console.log(`[lsp:vue/resolve] tsdk: ${tsdkPath}, exists: ${tsdkExists}`);
  if (!tsdkExists) return undefined;

  // @vue/typescript-plugin のパスを探す（tsserver --pluginProbeLocations 用）
  const pluginPrefix = "@vue+typescript-plugin@";
  let pluginProbeLocation: string | undefined;

  if (entriesResult.ok) {
    for (const entry of entriesResult.value) {
      if (entry.startsWith(pluginPrefix)) {
        const candidate = path.join(pnpmBase, entry, "node_modules");
        const pluginIndex = path.join(candidate, "@vue", "typescript-plugin", "index.js");
        if (fs.existsSync(pluginIndex)) {
          pluginProbeLocation = candidate;
          break;
        }
      }
    }
  }

  // hoisted の場合
  if (!pluginProbeLocation) {
    const directPlugin = path.join(
      packageDir,
      "node_modules",
      "@vue",
      "typescript-plugin",
      "index.js",
    );
    if (fs.existsSync(directPlugin)) {
      pluginProbeLocation = path.join(packageDir, "node_modules");
    }
  }

  if (!pluginProbeLocation) {
    console.log("[lsp:vue/resolve] @vue/typescript-plugin not found");
    return undefined;
  }
  console.log(`[lsp:vue/resolve] pluginProbeLocation: ${pluginProbeLocation}`);

  return { serverPath, tsdkPath, pluginProbeLocation };
}
