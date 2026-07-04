// git / gh 解決経路の spike 診断。GOZD_SPIKE_TEST=1 起動時に main プロセス内で実行し、
// 「実際に動く Electron main がどの git / credential helper を使うか」を stdout に残す。
//
// keychain 認証ダイアログ問題のデバッグ用: ダイアログは「keychain item の ACL に載っていない
// git-credential-osxkeychain（= 意図しない git）が実行された」ことを意味する。ACL は
// バイナリの cdhash 単位なので、helper の CDHash を出力して
// `security dump-keychain -a ~/Library/Keychains/login.keychain-db` の requirement と
// 突き合わせれば一致判定できる。
//
// - bun 等の別プロセスでの再現ではなく、本番と同一の Electron main 内で production の
//   commandResolver / fetchRemotes をそのまま通すことが診断価値の核
// - `GOZD_SPIKE_FETCH_DIR=<repo dir>` を併用すると、起動時 background fetch と同一経路
//   （fetchRemotes → runGitNonInteractive → resolver）で実 fetch を再現する。private repo を
//   指定すれば credential helper まで到達し、ダイアログが出るか / 出ないかで白黒がつく

import { tryCatch } from "@gozd/shared";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commandResolver } from "./commandResolver";
import { fetchRemotes } from "./git/gitOps";

const execFileAsync = promisify(execFile);

function log(message: string): void {
  console.log(`[spike:diag] ${message}`);
}

/** codesign は成功時も stderr に詳細を書く。CDHash 行を抽出する */
async function helperCdhash(helperPath: string): Promise<string> {
  const result = await tryCatch(execFileAsync("codesign", ["-d", "-vvv", helperPath]));
  if (!result.ok) return `codesign failed: ${result.error.message}`;
  const line = result.value.stderr.split("\n").find((l) => l.startsWith("CDHash="));
  return line ?? "CDHash line not found";
}

async function diagGit(): Promise<void> {
  const resolved = await tryCatch(commandResolver.resolve("git"));
  if (!resolved.ok) {
    log(`resolve git FAILED: ${resolved.error.message}`);
    return;
  }
  if (resolved.value === undefined) {
    log("resolve git -> not installed (command -v returned empty)");
    return;
  }
  const gitPath = resolved.value;
  log(`resolve git -> ${gitPath}`);

  const version = await tryCatch(execFileAsync(gitPath, ["--version"]));
  log(`git --version -> ${version.ok ? version.value.stdout.trim() : version.error.message}`);

  // credential helper（非絶対名 "osxkeychain"）は exec-path が最優先の探索先
  const execPath = await tryCatch(execFileAsync(gitPath, ["--exec-path"]));
  if (!execPath.ok) {
    log(`git --exec-path FAILED: ${execPath.error.message}`);
    return;
  }
  const helperDir = execPath.value.stdout.trim();
  log(`git --exec-path -> ${helperDir}`);

  const helperPath = join(helperDir, "git-credential-osxkeychain");
  log(`credential helper -> ${helperPath} (exists=${existsSync(helperPath)})`);
  if (existsSync(helperPath)) {
    log(`credential helper ${await helperCdhash(helperPath)}`);
  }

  const helperConfig = await tryCatch(
    execFileAsync(gitPath, ["config", "--show-origin", "--get-all", "credential.helper"]),
  );
  log(
    helperConfig.ok
      ? `credential.helper config -> ${helperConfig.value.stdout.trim().replaceAll("\n", " | ")}`
      : "credential.helper config -> (not set)",
  );
}

/** 起動時 background fetch と同一の production 経路で fetch を再現する */
async function diagFetch(dir: string): Promise<void> {
  log(`fetchRemotes(${dir}) — reproducing startup background fetch`);
  const result = await tryCatch(fetchRemotes(dir));
  log(result.ok ? "fetchRemotes OK" : `fetchRemotes FAILED: ${result.error.message}`);
}

export async function runSpikeResolverDiag(): Promise<void> {
  log(`process.env.PATH = ${process.env.PATH ?? "(unset)"}`);
  const shell = tryCatch(() => userInfo().shell);
  log(`login shell: userInfo.shell=${shell.ok ? shell.value : "?"} env.SHELL=${process.env.SHELL ?? "(unset)"}`);

  await diagGit();

  const gh = await tryCatch(commandResolver.resolve("gh"));
  if (gh.ok) log(`resolve gh -> ${gh.value ?? "not installed (command -v returned empty)"}`);
  else log(`resolve gh FAILED: ${gh.error.message}`);

  const fetchDir = process.env.GOZD_SPIKE_FETCH_DIR;
  if (fetchDir !== undefined && fetchDir !== "") {
    await diagFetch(fetchDir);
  }
  log("resolver diag done");
}
