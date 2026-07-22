// CLI cold start の launch request 消費。Swift 版 `AppRuntime.consumeLaunchRequest` の
// 対応物。gozd-cli が `GOZD_COLD_START` 時に `$TMPDIR/gozd-{channel}-launch/` へ
// `{"targetPath": "..."}` を書き出し（channel は GOZD_SOCKET_PATH のファイル名から導出）、
// app が起動時に最古の 1 件を読んで削除する。
//
// 読み取り・parse の成否に関わらず対象ファイルは削除する（Swift 版の defer removeItem と
// 同じ）。壊れた request を残すと起動のたびに拾われて永久に失敗し続けるため、
// 「consume = 削除」の意味論で揃える。Swift 版が silent に nil を返す失敗経路は、
// silent drop 禁止規律に合わせて stderr ログを足してある。

import { tryCatch } from "@gozd/shared";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export function consumeLaunchRequest(launchDir: string): string | undefined {
  // dir 不在（cold start されたことが無い）は正常系なので readdir 失敗 = undefined
  const entries = tryCatch(() => readdirSync(launchDir));
  if (!entries.ok || entries.value.length === 0) return undefined;

  // 作成時刻順で最古の 1 件だけ消費する（Swift 版と同じ契約。残りは次回起動に持ち越し）
  const sorted = entries.value
    .map((name) => {
      const path = join(launchDir, name);
      const stat = tryCatch(() => statSync(path));
      return { path, birthtimeMs: stat.ok ? stat.value.birthtimeMs : 0 };
    })
    .sort((a, b) => a.birthtimeMs - b.birthtimeMs);
  const [first] = sorted;
  if (first === undefined) return undefined;

  const parsed = tryCatch(() => JSON.parse(readFileSync(first.path, "utf8")) as unknown);
  rmSync(first.path, { force: true });
  if (!parsed.ok) {
    console.error(
      `[launchRequest] parse failed, request discarded: ${first.path}: ${parsed.error}`,
    );
    return undefined;
  }
  if (parsed.value === null || typeof parsed.value !== "object") {
    console.error(`[launchRequest] not an object, request discarded: ${first.path}`);
    return undefined;
  }
  const target = (parsed.value as Record<string, unknown>).targetPath;
  if (typeof target !== "string" || target === "") {
    console.error(`[launchRequest] targetPath missing, request discarded: ${first.path}`);
    return undefined;
  }
  return target;
}
