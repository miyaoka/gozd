// macOS 標準構成のアプリメニュー。Electron のデフォルトメニュー任せにせず明示定義する:
// デフォルトメニューは Electron バージョンで内容が変わり得るため、パッケージング後の
// 挙動をここで固定する。role ベースで OS 標準の項目とショートカット
// （Cmd+C/V、Cmd+Q、Cmd+M、Cmd+Ctrl+F 等）を得る。Swift 版は SwiftUI の
// デフォルトメニュー相当で、gozd 固有のメニュー項目は持たない（対応物なし）。

import { Menu } from "electron";

export function installAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      // fileMenu は置かない: 中身が Close Window (Cmd+W) だけで、Electron の menu
      // accelerator は renderer の keydown より先にキーを奪うため、renderer 側の
      // terminal.closePane (Cmd+W) が永久に呼ばれなくなる。Swift 期は WebView が
      // performKeyEquivalent で先に消費できたため共存できていたが、Electron では
      // menu から外すのが唯一の共存手段。window を閉じる経路は traffic light と
      // Cmd+Q (Quit) で足りる
      { role: "editMenu" },
      // View は role: "viewMenu" を使わず項目を書き下す: role の submenu は Electron が
      // 丸ごと供給するもので、そこに含まれる reload (Cmd+R) / forceReload (Shift+Cmd+R)
      // だけを抜く手段がない。メニューに renderer を作り直す項目を置かない理由は
      // docs/workspace.md の「ウィンドウ chrome」節。
      //
      // role: "reload" を残して accelerator だけ外す案は効かない。MenuItem は
      // accelerator 未指定のとき role の既定値を必ず埋めるため（overrideProperty の
      // `== null` 判定）、accelerator: undefined を明示しても Cmd+R が入る。
      {
        label: "View",
        submenu: [
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}
