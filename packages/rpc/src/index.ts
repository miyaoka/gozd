import type { RPCSchema } from "electrobun/bun";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
}

export interface FileReadResult {
  content: string;
  /** バイナリ等で読み取れなかった場合 true */
  isBinary: boolean;
}

/** LSP 診断情報（textDocument/publishDiagnostics の簡略版） */
export interface LspDiagnostic {
  /** 開始行（0-based） */
  startLine: number;
  /** 開始列（0-based） */
  startCharacter: number;
  /** 終了行（0-based） */
  endLine: number;
  /** 終了列（0-based） */
  endCharacter: number;
  /** メッセージ */
  message: string;
  /** 1=Error, 2=Warning, 3=Information, 4=Hint */
  severity: number;
}

/** git status の変更種別ごとのファイル数 */
export interface WorktreeChangeCounts {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

/** git worktree の情報 */
export interface WorktreeEntry {
  /** worktree のディレクトリパス */
  path: string;
  /** HEAD コミットの短縮ハッシュ */
  head: string;
  /** ブランチ名（detached HEAD の場合は undefined） */
  branch?: string;
  /** メインの worktree（clone 元）かどうか */
  isMain: boolean;
  /** git status の変更ファイル数サマリー */
  changeCounts?: WorktreeChangeCounts;
}

/** ファイルごとの診断結果 */
export interface FileDiagnostics {
  /** プロジェクトルートからの相対パス */
  relPath: string;
  diagnostics: LspDiagnostic[];
}

export type OrkisRPC = {
  bun: RPCSchema<{
    requests: {
      ptySpawn: {
        params: { cols: number; rows: number };
        response: number;
      };
      fsReadDir: {
        params: { relPath: string };
        response: FileEntry[];
      };
      fsReadFile: {
        params: { relPath: string };
        response: FileReadResult;
      };
      /** git show HEAD:<path> で変更前のファイル内容を取得 */
      gitShowFile: {
        params: { relPath: string };
        response: FileReadResult;
      };
      /** git diff <path> で unified diff を取得 */
      gitDiffFile: {
        params: { relPath: string };
        response: string;
      };
      gitStatus: {
        params: undefined;
        response: Record<string, string>;
      };
      /** git worktree list で worktree 一覧を取得 */
      gitWorktreeList: {
        params: undefined;
        response: WorktreeEntry[];
      };
      /** ローカルブランチ一覧を取得 */
      gitBranchList: {
        params: undefined;
        response: string[];
      };
      /** worktree を作成する（branch 未指定なら新規ブランチを自動生成） */
      gitWorktreeAdd: {
        params: { branch?: string };
        response: WorktreeEntry;
      };
      /** worktree を解除する（ブランチは残る） */
      gitWorktreeRemove: {
        params: { path: string; force?: boolean };
        response: void;
      };
      /** ローカルブランチを削除する */
      gitBranchDelete: {
        params: { branch: string };
        response: void;
      };
      /** 表示対象ディレクトリを切り替える（worktree 選択） */
      switchDir: {
        params: { dir: string };
        response: { dir: string; fileServerBaseUrl: string };
      };
    };
    messages: {
      ptyWrite: { id: number; data: string };
      ptyResize: { id: number; cols: number; rows: number };
      ptyKill: { id: number };
      openExternal: { url: string };
      rendererReady: void;
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      ptyData: { id: number; data: string };
      ptyExit: { id: number; exitCode: number };
      fsChange: { relDir: string };
      gitStatusChange: { statuses: Record<string, string> };
      /** 非アクティブ worktree でファイル変更が検知された通知 */
      worktreeChange: void;
      orkisOpen: { dir: string; file?: string; fileServerBaseUrl: string; channel: string };
      orkisHook: { event: string; payload: Record<string, unknown> };
      /** LSP 診断結果の更新（ファイル単位） */
      lspDiagnostics: FileDiagnostics;
    };
  }>;
};
