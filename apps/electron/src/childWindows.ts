// undock child window（renderer の window.open で生成）の BrowserWindow 集合。
//
// child window は createWindow() を通らず window.open で生まれるため、main 側からは
// did-create-window イベントでしか BrowserWindow を捕まえられない。捕まえたものを保持し、
// main window 向け操作（setTitleContext の全 window 適用等）から child を除外する判定に使う。
import type { BrowserWindow } from "electron";

const childWindows = new Set<BrowserWindow>();

export function registerChildWindow(window: BrowserWindow): void {
  childWindows.add(window);
  window.on("closed", () => {
    childWindows.delete(window);
  });
}

export function isChildWindow(window: BrowserWindow): boolean {
  return childWindows.has(window);
}
