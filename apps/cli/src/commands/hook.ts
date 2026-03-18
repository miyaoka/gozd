import { defineCommand } from "@miyaoka/fsss";
import { tryCatch } from "@orkis/shared";
import { z } from "zod";
import { sendMessage } from "../socket-client";

const HOOK_EVENTS = ["running", "done", "needs-input"] as const;

export default defineCommand({
  description: "Claude Code Hooks からのイベントを受け取る",
  args: {
    event: {
      type: z.enum(HOOK_EVENTS),
      description: "フックイベント名 (running | done | needs-input)",
      positional: true,
    },
  },
  async run({ args }) {
    // stdin から JSON を読み取る（Claude Code Hooks が渡す）
    const input = await Bun.stdin.text();
    const payload = input.trim() ? JSON.parse(input) : {};

    // PTY 環境変数から発火元のペインを特定する
    const ptyIdStr = process.env.ORKIS_PTY_ID;
    if (ptyIdStr !== undefined) {
      payload.ptyId = Number(ptyIdStr);
    }

    const result = await tryCatch(sendMessage({ type: "hook", event: args.event, payload }));
    if (!result.ok) {
      console.error(result.error.message);
      process.exit(1);
    }
  },
});
