import { createPinia } from "pinia";
import { createApp } from "vue";
import "./assets/main.css";
import App from "./App.vue";
import { initRpcDispatcher } from "./shared/rpc";

// native (Swift) からの `WebPage.callJavaScript("window.__gozdReceive(...)")` を受ける
// dispatcher を window に固定する。import 時の副作用を排し、bootstrap で 1 回だけ呼ぶ契約。
initRpcDispatcher();

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
