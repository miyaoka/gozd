import { createPinia } from "pinia";
import { createApp } from "vue";
import "./assets/main.css";
import App from "./App.vue";
import { initRpcDispatcher } from "./shared/rpc";

// main process からの push（`rpc:push`、preload の `__gozdElectronRpc.onPush` 経由）を
// 受ける dispatcher を接続する。import 時の副作用を排し、bootstrap で 1 回だけ呼ぶ契約。
initRpcDispatcher();

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
