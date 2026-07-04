import { contextBridge, ipcRenderer } from "electron";
import { SPIKE_TEST_ARG, type PtySpawnParams, type SpikeApi } from "./ipc";

const api: SpikeApi = {
  ptySpawn: (params: PtySpawnParams) => ipcRenderer.invoke("pty:spawn", params),
  ptyWrite: (id, data) => ipcRenderer.send("pty:write", id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send("pty:resize", id, cols, rows),
  onPtyData: (cb) => {
    ipcRenderer.on("pty:data", (_event, id: number, data: string) => cb(id, data));
  },
  onPtyExit: (cb) => {
    ipcRenderer.on("pty:exit", (_event, id: number, exitCode: number) => cb(id, exitCode));
  },
  reportSpikeResult: (ok, detail) => ipcRenderer.send("spike:report", ok, detail),
  isTestMode: process.argv.includes(SPIKE_TEST_ARG),
};

contextBridge.exposeInMainWorld("gozdSpike", api);
