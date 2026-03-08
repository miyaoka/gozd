import { contextBridge, ipcRenderer } from "electron";

const api = {
  pty: {
    spawn: (cols: number, rows: number): Promise<number> =>
      ipcRenderer.invoke("pty:spawn", cols, rows),
    write: (id: number, data: string) => ipcRenderer.send("pty:write", id, data),
    resize: (id: number, cols: number, rows: number) =>
      ipcRenderer.send("pty:resize", id, cols, rows),
    kill: (id: number) => ipcRenderer.send("pty:kill", id),
    onData: (callback: (id: number, data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number, data: string) =>
        callback(id, data);
      ipcRenderer.on("pty:data", listener);
      return () => ipcRenderer.removeListener("pty:data", listener);
    },
    onExit: (callback: (id: number, exitCode: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number, exitCode: number) =>
        callback(id, exitCode);
      ipcRenderer.on("pty:exit", listener);
      return () => ipcRenderer.removeListener("pty:exit", listener);
    },
  },
  onOpen: (callback: (dir: string, file?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dir: string, file?: string) =>
      callback(dir, file);
    ipcRenderer.on("orkis:open", listener);
    return () => ipcRenderer.removeListener("orkis:open", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);
