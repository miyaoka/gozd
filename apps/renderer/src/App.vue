<doc lang="md">
Phase 3 骨格デモ。新 `shared/rpc/` 経由で `/echo` RPC を呼び、Swift → renderer の
push（hook / open）を `onMessage` で購読する最小ハーネス。

`features/*` の旧 Vue SFC は新 RPC へ未移行のため、現時点で main から参照しない。
順次移植する。
</doc>

<script setup lang="ts">
import { EchoRequest } from "@gozd/proto";
import { ref } from "vue";
import { onMessage, rpcEcho } from "./shared/rpc";

const echoOut = ref("click echo to call /echo via gozd-rpc://");
const messageLog = ref<string[]>([]);

async function runEcho() {
  try {
    const resp = await rpcEcho(EchoRequest.create({ text: "hello from Vite dev" }));
    echoOut.value = `✓ ${resp.text}`;
  } catch (e) {
    echoOut.value = `✗ ${(e as Error).message}`;
  }
}

function logMessage(line: string) {
  const ts = new Date().toISOString().slice(11, 23);
  messageLog.value.unshift(`[${ts}] ${line}`);
  messageLog.value = messageLog.value.slice(0, 50);
}

onMessage("hook", (p) => logMessage(`hook ${JSON.stringify(p)}`));
onMessage("open", (p) => logMessage(`open ${JSON.stringify(p)}`));
onMessage("ptyText", (p) => logMessage(`ptyText id=${p.id} len=${p.text.length}`));
onMessage("ptyExit", (p) => logMessage(`ptyExit id=${p.id} reason=${JSON.stringify(p.reason)}`));
</script>

<template>
  <main class="min-h-screen bg-zinc-900 p-4 text-zinc-100">
    <h1 class="mb-3 text-base font-semibold">gozd renderer (Phase 3 skeleton)</h1>

    <section class="mb-4">
      <h2 class="mb-1 text-xs tracking-wider text-zinc-400 uppercase">/echo via gozd-rpc://</h2>
      <button class="rounded-sm bg-zinc-700 px-3 py-1 text-sm hover:bg-zinc-600" @click="runEcho">
        run echo
      </button>
      <pre class="mt-2 rounded-sm bg-zinc-950 p-2 text-xs">{{ echoOut }}</pre>
    </section>

    <section>
      <h2 class="mb-1 text-xs tracking-wider text-zinc-400 uppercase">
        Swift → renderer push (window.__gozdReceive)
      </h2>
      <pre class="max-h-80 overflow-auto rounded-sm bg-zinc-950 p-2 text-xs">{{
        messageLog.length > 0 ? messageLog.join("\n") : "waiting for push…"
      }}</pre>
    </section>
  </main>
</template>
