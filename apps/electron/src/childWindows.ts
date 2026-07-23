// undock child window（renderer の window.open で生成）の BrowserWindow registry。
//
// child window は createWindow() を通らず window.open で生まれるため、main 側からは
// did-create-window イベントでしか BrowserWindow を捕まえられない。window.open の
// frameName をキーに確保し、main window 向け操作（setTitleContext の全 window 適用等）から
// child を除外する判定に使う。
import type { BrowserWindow } from "electron";

const childWindows = new Map<string, BrowserWindow>();

export function registerChildWindow(frameName: string, window: BrowserWindow): void {
  childWindows.set(frameName, window);
  window.on("closed", () => {
    childWindows.delete(frameName);
  });
}

export function getChildWindow(frameName: string): BrowserWindow | undefined {
  return childWindows.get(frameName);
}

export function isChildWindow(window: BrowserWindow): boolean {
  for (const child of childWindows.values()) {
    if (child === window) return true;
  }
  return false;
}
