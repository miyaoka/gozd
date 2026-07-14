import type { ElectronRpcBridge } from "@gozd/shared";
import { contextBridge, ipcRenderer } from "electron";
import { GOZD_CHANNEL_ARG_PREFIX, SPIKE_TEST_ARG, type SpikeApi } from "./ipc";

// RPC 本経路。renderer の shared/rpc がこの有無でシェル（Electron / Swift）を判定する
const rpcBridge: ElectronRpcBridge = {
  request: (path, body) => ipcRenderer.invoke("rpc:request", path, body),
  onPush: (cb) => {
    ipcRenderer.on("rpc:push", (_event, type: string, payload: unknown) => cb(type, payload));
  },
};

const spikeApi: SpikeApi = {
  reportSpikeResult: (ok, detail) => ipcRenderer.send("spike:report", ok, detail),
  isTestMode: process.argv.includes(SPIKE_TEST_ARG),
};

// channel は「stable を明示的に受け取ったときだけ stable」の全域定義。
// 引数欠落や preload 不在の文脈はすべて非 packaged = dev 側に倒れる
const channelArg = process.argv.find((arg) => arg.startsWith(GOZD_CHANNEL_ARG_PREFIX));
const channel = channelArg === undefined ? "dev" : channelArg.slice(GOZD_CHANNEL_ARG_PREFIX.length);

contextBridge.exposeInMainWorld("__gozdElectronRpc", rpcBridge);
contextBridge.exposeInMainWorld("gozdSpike", spikeApi);
contextBridge.exposeInMainWorld("__gozdChannel", channel);
