import { tryCatch } from "@gozd/shared";

/**
 * OSC 7 の payload（`file://HOST/path` 形式の file URI）から cwd 絶対パスを抽出する。
 * HOST 部は無視する（gozd はローカル PTY のみを扱うため）。
 *
 * percent-decode の契約: gozd の zsh hook（`_gozd_osc7_cwd`）は encode せず生の $PWD を
 * 送るが、OSC 7 の標準系（iTerm2 shell integration / fish 等）は encode して送る。
 * 日本語ディレクトリ名などの非 ASCII パスを標準系から受けるため decode を試み、
 * 失敗（生パスに `%` + 非 hex が含まれる等）時は生文字列に倒す。
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
