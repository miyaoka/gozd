// macOS 標準構成のアプリメニュー。Electron のデフォルトメニュー任せにせず明示定義する:
// デフォルトメニューは Electron バージョンで内容が変わり得るため、パッケージング後の
// 挙動をここで固定する。role ベースで OS 標準の項目とショートカット
// （Cmd+C/V、Cmd+Q、Cmd+M、Cmd+Ctrl+F 等）を得る。Swift 版は SwiftUI の
// デフォルトメニュー相当で、gozd 固有のメニュー項目は持たない（対応物なし）。
//
// viewMenu の reload / toggleDevTools は残す判断: reload 後の renderer は dev の
// Vite フルリロードと同じ回復経路（mount 時の pull hydrate + onMessage 購読の貼り直し。
// architecture.md）を通るため、reload 用の特別な状態管理を main 側に足す必要はない。

import { Menu } from "electron";

export function installAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}
