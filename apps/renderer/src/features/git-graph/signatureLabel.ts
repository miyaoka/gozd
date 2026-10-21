import type { GitCommitSignature } from "@gozd/rpc";

/** 署名の表示文。gozd は署名を検証しないため、検証の成否と読める語（verified / not verified）を使わない。
 * `none` は署名が無いことを表すため表示文を持たない */
const SIGNATURE_TEXTS: Record<Exclude<GitCommitSignature, "none">, string> = {
  gpg: "GPG signed",
  ssh: "SSH signed",
  x509: "X.509 signed",
  unknown: "Signed (unknown format)",
};

export function signatureText(signature: Exclude<GitCommitSignature, "none">): string {
  return SIGNATURE_TEXTS[signature];
}
