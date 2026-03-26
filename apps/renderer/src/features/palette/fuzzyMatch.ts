/**
 * fzf V2 ライクなファジーマッチ（Smith-Waterman 変形）。
 * 動的計画法で全てのマッチ位置を検討し、最適スコアを返す。
 * V1（貪欲マッチ）と異なり、連続一致がある場合にそちらを正しく優先する。
 */

/** マッチ結果。null はマッチしなかったことを示す */
export interface FuzzyMatchResult {
  score: number;
}

// --- スコア定数（fzf 準拠） ---

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;

const BONUS_BOUNDARY = 8;
const BONUS_BOUNDARY_WHITE = 10;
const BONUS_BOUNDARY_DELIMITER = 9;
const BONUS_CAMEL_123 = 7;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

// --- 文字クラス ---

const enum CharClass {
  White = 0,
  NonWord = 1,
  Delimiter = 2,
  Lower = 3,
  Upper = 4,
  Letter = 5,
  Number = 6,
}

const DELIMITER_CHARS = new Set(["/", ",", ":", ";", "|", "-", "_", "."]);

function charClass(ch: string): CharClass {
  if (ch === " " || ch === "\t" || ch === "\n") return CharClass.White;
  if (DELIMITER_CHARS.has(ch)) return CharClass.Delimiter;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return CharClass.Number;
  if (code >= 65 && code <= 90) return CharClass.Upper;
  if (code >= 97 && code <= 122) return CharClass.Lower;
  if (ch.toLowerCase() !== ch.toUpperCase()) return CharClass.Letter;
  return CharClass.NonWord;
}

function bonusFor(prevCls: CharClass, cls: CharClass): number {
  if (cls > CharClass.NonWord) {
    if (prevCls === CharClass.White) return BONUS_BOUNDARY_WHITE;
    if (prevCls === CharClass.Delimiter) return BONUS_BOUNDARY_DELIMITER;
    if (prevCls === CharClass.NonWord) return BONUS_BOUNDARY;
  }
  if (prevCls === CharClass.Lower && cls === CharClass.Upper) return BONUS_CAMEL_123;
  if (prevCls !== CharClass.Number && cls === CharClass.Number) return BONUS_CAMEL_123;
  return 0;
}

/**
 * テキストに対してファジーマッチを行う（V2: 動的計画法）。
 * マッチしない場合は null を返す。
 */
export function fuzzyMatch(text: string, pattern: string): FuzzyMatchResult | null {
  const M = pattern.length;
  if (M === 0) return { score: 0 };

  const N = text.length;
  if (M > N) return null;

  const textLower = text.toLowerCase();
  const patternLower = pattern.toLowerCase();

  // --- Phase 1: マッチ可能か判定 + 検索範囲の特定 ---
  // パターンの各文字の最初の出現位置を記録
  const F = new Int32Array(M);
  let pidx = 0;
  let lastIdx = 0;
  for (let i = 0; i < N; i++) {
    if (textLower[i] === patternLower[pidx]) {
      F[pidx] = i;
      lastIdx = i;
      pidx++;
      if (pidx === M) break;
    }
  }
  if (pidx !== M) return null;

  // --- Phase 2: ボーナステーブルの構築 ---
  const B = new Int16Array(N);
  let prevCls: CharClass = CharClass.White;
  for (let i = 0; i < N; i++) {
    const cls = charClass(text[i]);
    B[i] = bonusFor(prevCls, cls);
    prevCls = cls;
  }

  // --- Phase 3: スコア行列の充填（動的計画法） ---
  // H[i][j] = パターン i 文字目がテキスト j 位置でマッチする最高スコア
  // C[i][j] = 連続マッチ長
  const f0 = F[0];
  const width = lastIdx - f0 + 1;

  const H = new Int16Array(M * width);
  const C = new Int16Array(M * width);

  // 1行目（パターン0文字目）の初期化
  const pchar0 = patternLower[0];
  let prevH0 = 0;
  let inGap = false;
  for (let off = 0; off < width; off++) {
    const j = off + f0;
    if (textLower[j] === pchar0) {
      const score = SCORE_MATCH + B[j] * BONUS_FIRST_CHAR_MULTIPLIER;
      H[off] = score;
      C[off] = 1;
      prevH0 = score;
      inGap = false;
    } else {
      const gap = inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      const score = Math.max(prevH0 + gap, 0);
      H[off] = score;
      C[off] = 0;
      prevH0 = score;
      inGap = true;
    }
  }

  // 2行目以降
  let maxScore = 0;
  if (M === 1) {
    // 1文字パターンは1行目の最大値
    for (let off = 0; off < width; off++) {
      if (H[off] > maxScore) maxScore = H[off];
    }
  }

  for (let i = 1; i < M; i++) {
    const pchar = patternLower[i];
    const row = i * width;
    let inGapRow = false;

    for (let off = 0; off < width; off++) {
      const j = off + f0;
      // パターン i 文字目の最初の出現位置より前はスキップ
      if (j < F[i]) {
        H[row + off] = 0;
        C[row + off] = 0;
        continue;
      }

      let s1 = 0;
      let consecutive = 0;

      if (textLower[j] === pchar && off > 0) {
        s1 = H[row - width + off - 1] + SCORE_MATCH;
        let b = B[j];
        consecutive = C[row - width + off - 1] + 1;

        if (consecutive > 1) {
          const fb = B[j - consecutive + 1];
          if (b >= BONUS_BOUNDARY && b > fb) {
            consecutive = 1;
          } else {
            b = Math.max(b, BONUS_CONSECUTIVE, fb);
          }
        }

        if (
          s1 + b <
          (off > 0 ? H[row + off - 1] : 0) + (inGapRow ? SCORE_GAP_EXTENSION : SCORE_GAP_START)
        ) {
          s1 += B[j];
          consecutive = 0;
        } else {
          s1 += b;
        }
      }

      const s2: number =
        off > 0 ? H[row + off - 1] + (inGapRow ? SCORE_GAP_EXTENSION : SCORE_GAP_START) : 0;

      C[row + off] = consecutive;
      inGapRow = s1 < s2;
      const score = Math.max(s1, s2, 0);

      if (i === M - 1 && score > maxScore) {
        maxScore = score;
      }
      H[row + off] = score;
    }
  }

  if (maxScore <= 0) return null;
  return { score: maxScore };
}
