// `gozd worktree new`（socket の newWorktree）の処理。
//
// 「同じ GitHub 参照に worktree は 1 つ」を守るのがこの層の責務。判定（既存 Task の
// 探索）と作成（worktree + Task）の間には await が挟まるため、判定だけでは守れない。
// **参照ごとに判定と作成をまとめて逐次化する**ことで、後から来たほうが必ず先行の
// 書き込みを見てから判定する順序を作る。参照が違えば並行のまま走る。
//
// 逐次化を socket の全メッセージに広げないのは、git の実行が秒単位かかり、全 PTY の
// 状態通知を止めるため（socketMessages.ts のキュー設計）。参照が同じ要求どうしだけが
// 待ち合わせる粒度に閉じる。
//
// 作成の依存を注入で受けるのは、この逐次化が守れているかを実 git / 実ホームを触らずに
// 検証できるようにするため。production の結線は socketMessages.ts が持つ。

import type {
  ClientReply,
  CreateTaskWorktreeRequest,
  CreateTaskWorktreeResponse,
  GhRef,
  NewWorktreeMessage,
  Task,
} from "@gozd/rpc";
import { ghRefLabel } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { basename } from "node:path";
import type { PushFn } from "./rpcDispatcher";

export interface NewWorktreeDeps {
  /** repo 内の任意の dir を main repo root へ解決する */
  resolveRoot: (dir: string) => Promise<string>;
  /** 同じ参照を持ち、生きている worktree に属する Task。無ければ undefined */
  findExisting: (rootDir: string, ghRef: GhRef) => Promise<Task | undefined>;
  /** worktree と Task を作る */
  create: (req: CreateTaskWorktreeRequest) => Promise<CreateTaskWorktreeResponse>;
}

/** 同じキーの operation を投入順に 1 本ずつ実行する。キーが違えば並行に走る。
 * 直前が失敗しても次を走らせる（失敗は呼び出し側へそのまま返る）。 */
function createKeyedQueue() {
  const chains = new Map<string, Promise<unknown>>();
  return function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve(undefined);
    const settled = previous.then(operation, operation);
    const tail = settled.catch(() => undefined);
    chains.set(key, tail);
    // 自分が最後尾のまま終わったキーだけ捨てる。待ち行列が続いているキーを消すと
    // 後続が空 chain から走り直して逐次化が破れる
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return settled;
  };
}

/** 参照の一意性を守る単位。repo が違えば同じ番号でも別物なので root を含める */
function ghRefKey(rootDir: string, ghRef: GhRef): string {
  return `${rootDir}\0${ghRef.kind}#${ghRef.number}`;
}

/** socket の newWorktree を処理して ClientReply の 1 行を返すハンドラを作る。
 *
 * 逐次化の状態はハンドラ 1 つに閉じる。production では main が 1 つだけ作る。
 *
 * worktree 作成と task 紐づけまでを main が完了させ、UI 反映（サイドバー掲載 /
 * claude の autostart）は push に委ねる。応答は「作成できたか」だけを表し、
 * push が届いたかは含まない — renderer が居ない状態でも worktree は正しく作られる。 */
export function createNewWorktreeHandler(deps: NewWorktreeDeps) {
  const enqueue = createKeyedQueue();

  const reply = (value: ClientReply): string => JSON.stringify(value);

  async function createAndPush(msg: NewWorktreeMessage, push: PushFn): Promise<string> {
    const created = await tryCatch(
      deps.create({
        dir: msg.dir,
        branch: "",
        startPoint: "",
        ghTitle: msg.title,
        ghRef: msg.ghRef,
      }),
    );
    if (!created.ok) {
      console.error(
        `[handleNewWorktree] createTaskWorktree failed: ${created.error} dir=${msg.dir}`,
      );
      return reply({ ok: false, dir: "", error: String(created.error) });
    }
    push("newWorktree", {
      ...created.value,
      prompt: msg.prompt,
      repoName: basename(created.value.rootDir),
    });
    return reply({ ok: true, dir: created.value.dir, error: "" });
  }

  /** 同じ参照の要求どうしで逐次化される区間。判定と作成をこの中に収める。 */
  async function checkAndCreate(
    msg: NewWorktreeMessage,
    ghRef: GhRef,
    rootDir: string,
    push: PushFn,
  ): Promise<string> {
    // 同じ PR / issue の task が既にあるなら作らない。エージェントが issue 一覧を読み直して
    // 同じ番号を再投入する経路が常にあり、通すと同一 issue に worktree が積み上がる。
    // UI の picker は既存 worktree への切り替えに倒すが、CLI には切り替える画面が無いので
    // 失敗として返し、既存の置き場所を実行者に伝える
    const existing = await tryCatch(deps.findExisting(rootDir, ghRef));
    if (!existing.ok) {
      console.error(`[handleNewWorktree] task lookup failed: ${existing.error} dir=${msg.dir}`);
      return reply({ ok: false, dir: "", error: String(existing.error) });
    }
    if (existing.value !== undefined) {
      return reply({
        ok: false,
        dir: "",
        error: `${ghRefLabel(ghRef)} already has a worktree at ${existing.value.worktreeDir}`,
      });
    }
    return createAndPush(msg, push);
  }

  return async function handleNewWorktree(msg: NewWorktreeMessage, push: PushFn): Promise<string> {
    if (msg.dir === "") {
      return reply({ ok: false, dir: "", error: "newWorktree: dir is required" });
    }
    // タイトル必須は CLI だけでなくここでも守る。socket は gozd が書いたと保証できない入力で、
    // CLI を経由しない送信でも「見分けの付かない Task」を作らせない
    if (msg.title === "") {
      return reply({ ok: false, dir: "", error: "newWorktree: title is required" });
    }
    const ghRef = msg.ghRef;
    // 参照を持たない要求に一意性の要求は無い。待たせる理由が無いので逐次化しない
    if (ghRef === undefined) return createAndPush(msg, push);

    const rootDir = await tryCatch(deps.resolveRoot(msg.dir));
    if (!rootDir.ok) {
      console.error(`[handleNewWorktree] resolveRoot failed: ${rootDir.error} dir=${msg.dir}`);
      return reply({ ok: false, dir: "", error: String(rootDir.error) });
    }
    return enqueue(ghRefKey(rootDir.value, ghRef), () =>
      checkAndCreate(msg, ghRef, rootDir.value, push),
    );
  };
}
