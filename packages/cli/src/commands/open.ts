import { defineCommand } from "@miyaoka/fsss";
import { tryCatch } from "@orkis/shared";
import { resolve } from "node:path";
import { z } from "zod";
import { sendMessage } from "../socket-client";

export default defineCommand({
  description: "指定ディレクトリを orkis で開く",
  args: {
    path: {
      type: z.string(),
      description: "プロジェクトディレクトリのパス",
      positional: true,
      default: ".",
    },
  },
  async run({ args }) {
    const absolutePath = resolve(args.path);
    const result = await tryCatch(sendMessage({ type: "open", path: absolutePath }));
    if (!result.ok) {
      console.error(result.error.message);
      process.exit(1);
    }
  },
});
