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
/** 同一ホストへ同時に張る TLS 接続の上限。多数の repo が一度に fetch すると、バーストで負けた
 * 接続が確立できず OS の TCP timeout まで hang する。git には connect timeout を縛る config が
 * 無い（`http.lowSpeedLimit/Time` は接続後の転送しか縛れない）ため、発射側で同時数を絞る。
 * VSCode が複数 repo 横断の git 操作を並列 5 に絞る（`Limiter(5)`）のと同値・同理由 */
const NETWORK_CAP = 5;

export const DEFAULT_GIT_ADMISSION_LIMITS: GitAdmissionLimits = {
  generalCap: Math.max(
    MIN_GENERAL_CAP,
    Math.min(MAX_GENERAL_CAP, availableParallelism() - RESERVED_CORES),
  ),
  interactiveHeadroom: 2,
  networkCap: NETWORK_CAP,
};

/** ネットワークを待つ git サブコマンド。認証やリモートの応答で長く居座るため general と分ける */
const NETWORK_SUBCOMMANDS = new Set(["fetch", "pull", "push", "ls-remote", "clone"]);

/** git の引数列から予算を決める。`-c key=value` などの前置オプションを飛ばしたサブコマンドで判定する */
export function gitBudgetOf(args: string[]): GitBudget {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // 値を別引数に取る前置オプション
    if (arg === "-c" || arg === "-C") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return NETWORK_SUBCOMMANDS.has(arg) ? "network" : "general";
  }
  return "general";
}

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
