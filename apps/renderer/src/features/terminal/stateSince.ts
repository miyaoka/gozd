import { displayClaudeState, type ClaudeState, type ClaudeStatus } from "./claudeStatus";

/** 端末の表示上の Claude 状態と、その状態に入った時刻（Unix ミリ秒） */
export interface StateSince {
  state: ClaudeState;
  since: number;
}

/**
 * 表示上の状態（`displayClaudeState`）が変わった端末だけ、状態に入った時刻を `now` に進める。
 *
 * 状態別の一覧はグループ内をこの時刻の新しい順に並べる。並びが変わるきっかけを状態の変化に
 * 限るため、同じ状態のままの付随データの更新（done のメッセージ、teammate の台帳）では
 * 時刻を動かさない。
 *
 * 変化が無ければ `prev` をそのまま返す（参照が変わらないので購読側を再計算させない）。
 * 状態の無くなった端末（Claude の終了 / 端末の close）のエントリは落とす。
 */
export function nextStateSince(
  prev: Readonly<Record<number, StateSince>>,
  statuses: Readonly<Record<number, ClaudeStatus>>,
  now: number,
): Readonly<Record<number, StateSince>> {
  const next: Record<number, StateSince> = {};
  let changed = false;
  for (const [key, status] of Object.entries(statuses)) {
    const ptyId = Number(key);
    const state = displayClaudeState(status);
    if (state === undefined) continue;
    const previous = prev[ptyId];
    if (previous?.state === state) {
      next[ptyId] = previous;
      continue;
    }
    next[ptyId] = { state, since: now };
    changed = true;
  }
  if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
  return next;
}
