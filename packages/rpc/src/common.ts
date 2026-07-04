// 複数 RPC で共有される値型をここにまとめる。
// 1 つの RPC でしか使わない型は当該 RPC のファイルに置く。
//
// ワイヤ / 永続化契約: フィールド名がそのまま JSON キーになる（旧 proto3 JSON mapping の
// lowerCamelCase 表記を踏襲）。`?` 付きフィールドは「JSON キー不在」で未設定を表現する。

/** 空 message。空 request / 空 response の型に使う */
export type EmptyMessage = Record<string, never>;

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
  isMain: boolean;
  /** ファイル相対パス → porcelain v2 XY コード（未変更側は "."。例: ".M", "A.", "R.", "??"） */
  gitStatuses: Record<string, string>;
  /** rename / copy エントリの 新パス → 旧パス。`gitStatuses` のキーは新パスのみ持つため、
   * 旧パス (HEAD 側の比較元) はこの map で運ぶ。rename が無ければ空。 */
  renameOldPaths: Record<string, string>;
  tasks: Task[];
  /** upstream（追跡リモートブランチ）に対する差分。upstream 未設定なら不在。
   * optional により「未設定」をフィールド不在で表現し、ahead/behind を見るには
   * upstream 自体の存在をチェックする契約を型レベルで強制する。 */
  upstream?: UpstreamStatus;
  /** 変更ファイルの最終更新時刻 (Unix 秒)。`gitStatuses` の各パスを stat した最大値。
   * clean (差分なし) / stat 全失敗のときは 0。削除済みパスは stat 失敗で自動除外される。
   * `gitStatuses` / `upstream` と同じ 1 セットとして書き込まれる契約 (SSOT)。 */
  latestMtime: number;
}

/** upstream（追跡リモートブランチ）との差分。`git status --porcelain=v2 --branch` の
 * `# branch.ab` 行に対応。upstream 自体が未設定のときはこの型ごと不在になる。 */
export interface UpstreamStatus {
  /** upstream に対して先行しているローカルコミット数（未 push）。 */
  ahead: number;
  /** upstream に対して遅れているリモートコミット数（未 pull）。 */
  behind: number;
}

export interface Task {
  /** UUID。Claude session とは独立した task 固有の identity。 */
  id: string;
  worktreeDir: string;
  /** GitHub PR / issue 参照。GitHub の PR / issue は同一の番号空間を共有するため、
   * 種別 + 番号の組で 1 件を表す。task 1 件あたり最大 1 つ。 */
  ghRef?: GhRef;
  /** ISO 8601 */
  createdAt: string;
  /** 最後に attach された Claude session の ID。空文字は session 未起動 / 終了済み。
   * SessionEnd では消さず保持し、サイドバークリック時の `claude --resume` 起点に使う。 */
  sessionId: string;
  /** ユーザーが明示的にターミナルを close した task かどうか。
   * SessionEnd / terminal close (detachSession) で true に倒し、resume クリック /
   * PR picker 再選択 / 同 sid SessionStart hook (attachSession) で false に戻す。
   * app close (renderer 強制終了) では detachSession 経路を通らないため据え置き。
   * サイドバー UI の "closed" / "resumable" 状態区別に使う。 */
  closedByUser: boolean;
  /** ユーザーが UI で明示的に編集 / rename した確定値。最優先で表示に使う。
   * 空文字は「ユーザー指定なし」(= ghTitle / terminalTitle へフォールバック) を意味する。 */
  userTitle: string;
  /** OSC ターミナルタイトル経由で観測した live 値。userTitle / ghTitle が空のときの
   * 最終フォールバック。Claude が transcript 起動直後に送る placeholder ("Claude Code")
   * は表示側で除外する。 */
  terminalTitle: string;
  /** PR/issue picker 取得時の snapshot タイトル。userTitle が空のときの第 2 優先表示で、
   * OSC タイトル更新では触らない (gh ↔ terminal の独立性が SSOT)。 */
  ghTitle: string;
}

/** GitHub PR / issue 参照。 */
export interface GhRef {
  kind: GhRefKind;
  number: number;
}

/** tasks.json に永続化される値。旧 proto3 JSON の enum 名をそのまま維持する
 * （merge までは main branch の Swift 版 gozd と同じ tasks.json を共有するため、
 * 文字列を変えると Swift 側の parse が失敗し実運用の task データが reinit で消える）。
 * kind の組み立ては helpers.ts の ghRefForPr / ghRefForIssue 経由に限定する。 */
export type GhRefKind = "GH_REF_KIND_PR" | "GH_REF_KIND_ISSUE";

export interface FileReadResult {
  /** UTF-8 として decode できなかった場合は空 + isBinary=true */
  content: string;
  isBinary: boolean;
  isDirectory: boolean;
  notFound: boolean;
}

export interface GitFileChange {
  oldFilePath: string;
  newFilePath: string;
  /** "A" / "M" / "D" / "R" / "U" */
  type: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  /** Unix timestamp（秒） */
  date: number;
  message: string;
  body: string;
  refs: string[];
  /** この commit の直上で履歴が途切れている (上の行とは連続しない別セグメントの先頭)
   * ことを示す。全ブランチ表示で現在ブランチ (HEAD) が新しい順 maxCount ウィンドウから
   * 押し出されたとき、HEAD-only walk を末尾 append する境界の先頭 commit に立つ。
   * renderer はこの行の上に「途切れ行」を描き、最新クラスタと現在ブランチクラスタの
   * 不連続を可視化する。 */
  truncatedAbove: boolean;
}

export interface GitPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  assignees: string[];
  reviewers: string[];
  /** ISO 8601 */
  updatedAt: string;
  authorAvatarUrl: string;
  /** base branch の commit OID (immutable identifier)。base ref 名と異なり、
   * fork PR / base force-push / base rename にまたがって安定して base 端を識別できる。
   * PR diff 表示モードで「base..working tree」の base 端に使う SSOT。 */
  baseRefOid: string;
}

export interface GitIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  authorAvatarUrl: string;
}
