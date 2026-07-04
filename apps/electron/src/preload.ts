import type { ElectronRpcBridge } from "@gozd/shared";
import { contextBridge, ipcRenderer } from "electron";
import { SPIKE_TEST_ARG, type SpikeApi } from "./ipc";

// RPC 本経路。renderer の shared/rpc がこの有無でシェル（Electron / Swift）を判定する
const rpcBridge: ElectronRpcBridge = {
  request: (path, bodyJson) => ipcRenderer.invoke("rpc:request", path, bodyJson),
  onPush: (cb) => {
    ipcRenderer.on("rpc:push", (_event, type: string, payload: unknown) => cb(type, payload));
  },
};

const spikeApi: SpikeApi = {
  reportSpikeResult: (ok, detail) => ipcRenderer.send("spike:report", ok, detail),
  isTestMode: process.argv.includes(SPIKE_TEST_ARG),
};

contextBridge.exposeInMainWorld("__gozdElectronRpc", rpcBridge);
contextBridge.exposeInMainWorld("gozdSpike", spikeApi);
