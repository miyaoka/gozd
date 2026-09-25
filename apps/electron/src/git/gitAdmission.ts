// main が起動する git 子プロセスの同時実行数を束ねる admission。
//
// git status は作業ツリー全体を lstat / readdir するため、大きな作業ツリーで同時に走らせると
// カーネル（ファイルシステム層）で詰まり、並列度を上げても完了は早まらない。同時に走る
// 無関係な git（git log 等）とターミナル内のプロンプトまで巻き込んで遅らせる。
// そのため起動前に枠を取らせ、上限を超える分は待たせる。
//
// - 予算は 2 つ。ローカルで完結する general と、ネットワークを待つ network。fetch のように
//   ネットワーク待ちで長く居座るものが general の枠を塞がないよう分ける
// - general には優先度がある。interactive（画面が応答を待つもの）は background（監視が
//   裏で取り直すもの）より先に通し、さらに interactive だけが使える予備枠を持つ。background が
//   上限まで埋まっていても、画面の要求は待たずに走れる
// - 優先度は呼び出し経路で決まるため、関数引数で運ばず AsyncLocalStorage で伝播する。
//   指定の無い経路は interactive

import { tryCatch } from "@gozd/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";

export type GitTier = "interactive" | "background";
export type GitBudget = "general" | "network";

export interface GitAdmissionLimits {
  /** general 予算で background / interactive が共有する上限 */
  generalCap: number;
  /** interactive だけが generalCap を超えて使える予備枠 */
  interactiveHeadroom: number;
  networkCap: number;
}

/** 走査の並列度を上げても完了は早まらない（大きな作業ツリーで計測すると 4 前後が最速で、
 * それ以上は全体が遅くなる）。CPU の少ない環境でも 2 は確保する */
const MIN_GENERAL_CAP = 2;
const MAX_GENERAL_CAP = 4;
/** renderer / 他プロセスの取り分として残すコア数 */
const RESERVED_CORES = 4;

export const DEFAULT_GIT_ADMISSION_LIMITS: GitAdmissionLimits = {
  generalCap: Math.max(
    MIN_GENERAL_CAP,
    Math.min(MAX_GENERAL_CAP, availableParallelism() - RESERVED_CORES),
  ),
  interactiveHeadroom: 2,
  networkCap: 3,
};

interface Waiter {
  budget: GitBudget;
  tier: GitTier;
  start: () => void;
}

export function createGitAdmission(limits: GitAdmissionLimits) {
  const running: Record<GitBudget, number> = { general: 0, network: 0 };
  /** 到着順。優先度は取り出し時に tier で選ぶ */
  const waiters: Waiter[] = [];

  function canStart(budget: GitBudget, tier: GitTier): boolean {
    if (budget === "network") return running.network < limits.networkCap;
    const cap =
      tier === "interactive" ? limits.generalCap + limits.interactiveHeadroom : limits.generalCap;
    return running.general < cap;
  }

  /** 待機列から、いま開始できるものを優先度順に開始する */
  function drain(): void {
    for (const tier of ["interactive", "background"] as const) {
      for (let i = 0; i < waiters.length;) {
        const waiter = waiters[i];
        if (waiter.tier !== tier || !canStart(waiter.budget, waiter.tier)) {
          i++;
          continue;
        }
        waiters.splice(i, 1);
        waiter.start();
      }
    }
  }

  /** 枠を取ってから task を実行し、完了（成功 / 失敗）で枠を返す */
  async function run<T>(budget: GitBudget, tier: GitTier, task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => {
        running[budget]++;
        resolve();
      };
      if (canStart(budget, tier)) {
        start();
        return;
      }
      waiters.push({ budget, tier, start });
    });
    const result = await tryCatch(task());
    running[budget]--;
    drain();
    if (!result.ok) throw result.error;
    return result.value;
  }

  return { run };
}

const tierStorage = new AsyncLocalStorage<GitTier>();

/** fn の中で起動される git をすべて tier で実行する */
export function withGitTier<T>(tier: GitTier, fn: () => Promise<T>): Promise<T> {
  return tierStorage.run(tier, fn);
}

export function currentGitTier(): GitTier {
  return tierStorage.getStore() ?? "interactive";
}
