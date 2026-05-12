/**
 * manifest.iconDefinitions と SVG URL マップから「アイコン名 → URL」マップを構築する。
 * iconPath の basename を SVG ルックアップキーに使うことで `.clone` サフィックス等の派生規則にも追従する。
 */
export function buildIconUrlByName(
  iconDefinitions: Record<string, { iconPath: string }>,
  svgUrlByBasename: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, def] of Object.entries(iconDefinitions)) {
    // iconPath: "./../icons/folder-development.clone.svg" → basename "folder-development.clone"
    const [, basename] = def.iconPath.match(/\/([^/]+)\.svg$/) ?? [];
    if (basename === undefined) {
      throw new Error(
        `material-icon-theme: cannot extract basename from iconPath ${JSON.stringify(
          def.iconPath,
        )} for icon ${JSON.stringify(name)}`,
      );
    }
    const url = svgUrlByBasename.get(basename);
    if (url === undefined) {
      throw new Error(
        `material-icon-theme: SVG ${JSON.stringify(`${basename}.svg`)} not found for icon ${JSON.stringify(name)}`,
      );
    }
    result.set(name, url);
  }
  return result;
}
