import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineCommand } from "@miyaoka/fsss";
import { tryCatch } from "@orkis/shared";
import { z } from "zod";
import { sendMessage } from "../socket-client";

/**
 * パスをワークスペースディレクトリとファイルに分解する。
 * - ディレクトリ → { dir }
 * - ファイル → { dir: 親ディレクトリ, file }
 * - 存在しない → { dir: 親ディレクトリ, file }（新規ファイル扱い）
 */
function resolveTarget(inputPath: string): { dir: string; file?: string } {
  const absolutePath = resolve(inputPath);
  if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    return { dir: absolutePath };
  }
  return { dir: dirname(absolutePath), file: absolutePath };
}

export default defineCommand({
  description: "指定パスを orkis で開く",
  args: {
    path: {
      type: z.string(),
      description: "ディレクトリまたはファイルのパス",
      positional: true,
      default: ".",
    },
  },
  async run({ args }) {
    const target = resolveTarget(args.path);
    const result = await tryCatch(sendMessage({ type: "open", ...target }));
    if (!result.ok) {
      console.error(result.error.message);
      process.exit(1);
    }
  },
});
