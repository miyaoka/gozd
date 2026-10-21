import type { GitCommitSignature } from "@gozd/rpc";

/** 署名方式の表示名。`none` は署名が無いことを表すため名前を持たない */
const SIGNATURE_LABELS: Record<Exclude<GitCommitSignature, "none">, string> = {
  gpg: "GPG",
  ssh: "SSH",
  x509: "X.509",
  unknown: "Unknown",
};

/** 署名の表示文。gozd は署名を検証しないため、検証の成否と読める語（verified / not verified）を使わない */
export function signatureText(signature: Exclude<GitCommitSignature, "none">): string {
  return `${SIGNATURE_LABELS[signature]} signed`;
}
