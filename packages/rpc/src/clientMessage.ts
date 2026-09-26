// CLI / nc から SocketServer へ送られるメッセージ。
// NDJSON 1 行 = 1 ClientMessage。
//
// ワイヤ形状は旧 proto3 oneof の JSON mapping（`{"hook":{...}}` / `{"open":{...}}`）を
// そのまま維持する。nc 直送コマンドに固定 JSON として埋め込める:
//
//   echo '{"hook":{"event":"running","ptyId":'"$GOZD_PTY_ID"'}}' | nc -w 1 -U "$GOZD_SOCKET_PATH"
//
// フィールドは最大 1 つだけ設定される（すべて undefined は不正メッセージとして
// 受信側でログの上 drop する）。
//
// 応答は種別ごとに決まる。hook / open は送りっぱなしで応答を返さない。それ以外は
// `ClientReply` の JSON 1 行を返してから接続を閉じる。実行者（エージェント）が結果を
// 知らずに次の指示へ進めないため、操作と問い合わせの種別は双方向にする。

export interface ClientMessage {
  hook?: HookMessage;
  open?: OpenMessage;
  newWorktree?: NewWorktreeMessage;
  repoList?: RepoListMessage;
  sessionList?: SessionListMessage;
  sessionOpen?: SessionOpenMessage;
  worktreeRemove?: WorktreeRemoveMessage;
}

/** Claude Code の hook イベント通知。
 * 軽量な nc 直送経路では event / ptyId のみが JSON に載る（他フィールドはキー不在）。
 * 受信側 (socketMessages.ts) が default 充填してから使う契約。
 * CLI 経由の rich 経路では全フィールドが埋まる。 */
export interface HookMessage {
  /** "session-start" / "session-end" / "running" / "done" / "needs-input" /
   * "tool-done" / "tool-failure" / "stop-failure" / "subagent-start" /
   * "subagent-stop" / "teammate-idle" */
  event: string;
  ptyId: number;

  /** CLI 経由のみ */
  lastAssistantMessage: string;
  toolName: string;
  /** Claude Code の tool_input をそのまま JSON 文字列として保持 */
  toolInput: string;

  /** session-start / session-end のみ。Claude Code の resume 起動に必要。 */
  sessionId: string;

  /** "done" (Stop) のみ。Stop 発火時に background_tasks（type "teammate" を除く）/
   * session_crons のいずれかが残っているか。CLI が stdin の 2 配列を OR で畳んで立てる。
   * true のときは主エージェントのターンは終わったが裏で作業が継続中（= 再起動する）ため、
   * 真の done ではない。
   *
   * teammate 型を数えないのは、teammate（Agent ツールの name 付き spawn）が idle 化しても
   * background_tasks に status "running" のまま session 終了まで残り続けるため（完了の概念が
   * entry の除去に接続されていない）。数えると一度 teammate を spawn した session が永続的に
   * working 表示になる。teammate の稼働判定は renderer が subagent lifecycle hook
   * （subagent-start / subagent-stop / teammate-idle）の台帳で行う。 */
  pendingWork: boolean;

  /** "done" (Stop) のみ。background_tasks に type "teammate" のエントリが残っているか。
   * false は「teammate 形状の子は生存し得ない」完全な台帳の証明なので、renderer が
   * lifecycle hook を取りこぼして残留した teammate 台帳の掃除ガードに使う。 */
  hasTeammateTask: boolean;

  /** "subagent-start" / "subagent-stop" のみ。Claude Code が子エージェントに振る一意 id。
   * teammate は `a<name>-<hex>` 形状、one-shot subagent は `a<hex>` 形状。 */
  agentId: string;

  /** "teammate-idle" のみ。idle に遷移した teammate の名前。 */
  teammateName: string;

  /** session-start のみ。"startup" / "resume" / "clear" / "compact" 等 */
  source: string;
}

/** `gozd open <path>` から送られるプロジェクトを開けの指示。 */
export interface OpenMessage {
  targetPath: string;
}

/** `gozd worktree new` から送られる「作業スペースを 1 つ増やしてエージェントを立てろ」の指示。
 * エージェントが自分で次の作業単位を切り出すための入口で、UI の PR / issue picker と
 * 同じ合成操作（worktree 作成 + claude 自動起動）を駆動する。
 *
 * 起動した claude へのプロンプトは、picker が URL を入力欄へ挿入して人の送信を待つのに対し、
 * こちらは引数で渡してそのまま走らせる。作業を切り出す側は相手が動き出すことまでを含めて
 * 指示している。セッションの名前は Claude が初期プロンプトから付ける。 */
export interface NewWorktreeMessage {
  /** 実行時の cwd。main 側で main repo root に解決する */
  dir: string;
  /** 起動した claude に引数で渡すプロンプト（送信され、そのまま実行が始まる）。
   * 空なら素の claude を起動する */
  prompt: string;
}

/** `gozd repo list` から送られる、gozd に登録された repo の問い合わせ。 */
export type RepoListMessage = Record<string, never>;

/** `gozd session list` から送られる、登録済みの全 repo のセッションの問い合わせ。 */
export type SessionListMessage = Record<string, never>;

/** `gozd session open <id>` から送られる、セッションを開けの指示。端末が開いていれば
 * その端末へ、開いていなければ再開して、画面をそのセッションへ切り替える。 */
export interface SessionOpenMessage {
  sessionId: string;
}

/** `gozd worktree remove <path>` から送られる、worktree を削除しろの指示。
 * 窓口の端末からの要求だけを受け付け、変更中のファイル・稼働中のセッションがある worktree は
 * 削除しない。判定はすべて main 側が行う。 */
export interface WorktreeRemoveMessage {
  /** 削除する worktree の絶対パス */
  path: string;
  /** 要求元の端末（`GOZD_PTY_ID`）。窓口の端末かの判定に使う */
  ptyId: number;
}

/** `gozd repo list` が返す 1 repo。 */
export interface CliRepo {
  rootDir: string;
  name: string;
  isGitRepo: boolean;
  /** git repo の worktree。main worktree を含む。非 git project は空 */
  worktrees: CliWorktree[];
}

export interface CliWorktree {
  path: string;
  /** detached HEAD は空文字 */
  branch: string;
  isMain: boolean;
}

/** `gozd session list` が返す 1 セッション。 */
export interface CliSession {
  sessionId: string;
  /** セッションを起動した作業ディレクトリ */
  cwd: string;
  /** 所属する repo の rootDir */
  rootDir: string;
  title: string;
  /** セッションログの最終更新時刻 (ISO 8601) */
  lastModified: string;
  /** gozd の端末で動いているか */
  live: boolean;
}

/** 応答を返す種別の ClientMessage に対して、socket が閉じる前に 1 行だけ返すメッセージ。 */
export interface ClientReply {
  ok: boolean;
  /** newWorktree / sessionOpen / worktreeRemove が ok のとき、対象の絶対パス。それ以外は空文字 */
  dir: string;
  /** ok=false のときの失敗理由。ok では空文字 */
  error: string;
  /** repoList が ok のときだけ持つ */
  repos?: CliRepo[];
  /** sessionList が ok のときだけ持つ */
  sessions?: CliSession[];
}

/** hook push payload。socket で受けた `HookMessage` から送信経路情報 (`source`) を
 * 落とした形をそのまま renderer へ転送する。 */
export type HookPayload = Omit<HookMessage, "source">;
