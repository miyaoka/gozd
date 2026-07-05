import { tryCatch } from "@gozd/shared";

/**
 * OSC 7 の payload（`file://HOST/path` 形式の file URI）から cwd 絶対パスを抽出する。
 * HOST 部は無視する（gozd はローカル PTY のみを扱うため）。
 *
 * percent-decode の契約: 常に decode を試みる。gozd の zsh hook（`_gozd_osc7_cwd`）は
 * `%` のみ `%25` に escape した $PWD を送るため round-trip が正確に成立し、
 * OSC 7 の標準系（iTerm2 shell integration / fish 等）の full encode もそのまま decode
 * できる。第三者 integration が escape なしの生パスを送るケースだけは `%` + 非 hex で
 * decode が throw しうるため、失敗時は生文字列に倒す（`%` + 有効 hex の誤 decode は
 * 原理的に区別できず許容する）。
 */
export function parseOsc7Cwd(data: string): string | undefined {
  if (!data.startsWith("file://")) return undefined;
  const rest = data.slice("file://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return undefined;
  const rawPath = rest.slice(slashIdx);
  const decoded = tryCatch(() => decodeURIComponent(rawPath));
  return decoded.ok ? decoded.value : rawPath;
}
