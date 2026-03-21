import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineCommand } from "@miyaoka/fsss";
import { tryCatch } from "@gozd/shared";
import { z } from "zod";
import { sendMessage } from "../socket-client";

const LAUNCH_DIR = join(tmpdir(), "gozd-stable-launch");

/** cold start 用の launch request ファイルを書き出す */
function writeLaunchRequest(request: { targetPath: string }): void {
  mkdirSync(LAUNCH_DIR, { recursive: true });
  const filename = `${crypto.randomUUID()}.json`;
  writeFileSync(`${LAUNCH_DIR}/${filename}`, JSON.stringify(request));
}

export default defineCommand({
  description: "指定パスを gozd で開く",
  args: {
    path: {
      type: z.string(),
      description: "ディレクトリまたはファイルのパス",
      positional: true,
      default: ".",
    },
  },
  async run({ args }) {
    const targetPath = resolve(args.path);

    // cold start: request ファイルを書いてアプリに渡す（ソケット送信しない）
    if (process.env.GOZD_COLD_START) {
      writeLaunchRequest({ targetPath });
      return;
    }

    // warm start: ソケット経由で既存アプリに送信
    // パス解決（プロジェクト判定・worktree root 解決）は desktop 側で行う
    const result = await tryCatch(sendMessage({ type: "open", targetPath }));
    if (!result.ok) {
      console.error(result.error.message);
      process.exit(1);
    }
  },
});
