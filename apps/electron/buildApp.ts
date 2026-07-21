// .app パッケージング（package.json build:app の electron-builder 呼び出し部）。
// channel identity の焼き込みを担う:
//   - GOZD_BUILD_CHANNEL=stable（release CI のみ）→ productName "Gozd" / marker "stable"
//   - 無指定 → local channel（productName "Gozd Local"、appId 末尾 .local、marker "local"）。
//     mise 配布の Gozd と socket / bundle id が分かれ、隣で共存・同時起動できる
// marker は Resources/app/channel に書く。実行時は gozdEnv（main）と bin/gozd（wrapper）が読む。
// GOZD_BUILD_VERSION（release CI が canary の tag 由来 version を渡す）は electron-builder の
// extraMetadata.version として同梱 package.json に注入され、About パネルの表示になる。
// stable は事前に人間が bump した package.json の version がそのまま使われるため注入しない。

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const APP_ID = "io.github.miyaoka.gozd.electron";

const channelEnv = process.env.GOZD_BUILD_CHANNEL;
if (channelEnv !== undefined && channelEnv !== "" && channelEnv !== "stable") {
  throw new Error(`GOZD_BUILD_CHANNEL must be "stable" or unset, got: ${channelEnv}`);
}
const channel = channelEnv === "stable" ? "stable" : "local";
const productName = channel === "stable" ? "Gozd" : "Gozd Local";

/** stdout を捕捉して返す（git 等の値取り用） */
function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

/** 出力を流しながら実行する（electron-builder 用） */
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

// CFBundleVersion にコミット日時 + hash を注入する（About パネルのビルド識別と
// wrapper の ~/Applications 同期の比較キー）。dirty ビルドは hash に -dirty が付く
const commitDate = capture("git", ["show", "-s", "--format=%cd", "--date=format:%Y%m%d-%H%M%S", "HEAD"]);
const commitHash = capture("git", ["describe", "--always", "--dirty"]);

const builderArgs = ["exec", "electron-builder", "--dir", `-c.buildVersion=${commitDate} ${commitHash}`];
if (channel === "local") {
  // productName は Info.plist（-c.productName）と同梱 package.json（extraMetadata。実行時の
  // app.name = メニューラベル）の両方に効かせる。片方だけだと About とメニューで名前が食い違う
  builderArgs.push(
    `-c.productName=${productName}`,
    `-c.appId=${APP_ID}.local`,
    `-c.extraMetadata.productName=${productName}`,
  );
}
const buildVersion = process.env.GOZD_BUILD_VERSION;
if (buildVersion !== undefined && buildVersion !== "") {
  builderArgs.push(`-c.extraMetadata.version=${buildVersion}`);
}
run("pnpm", builderArgs);

writeFileSync(
  join("out", "mac-arm64", `${productName}.app`, "Contents", "Resources", "app", "channel"),
  channel,
);
console.error(`[buildApp] packaged ${productName}.app (channel=${channel})`);
