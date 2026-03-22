import type { RPCSchema } from "electrobun/bun";
import { z } from "zod";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
}

export interface FileReadResult {
  content: string;
  /** バイナリ等で読み取れなかった場合 true */
  isBinary: boolean;
  /** パスが存在しない場合 true */
  notFound?: boolean;
  /** パスがディレクトリの場合 true */
  isDirectory?: boolean;
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
  /** 紐づく Todo */
  todo?: Todo;
}

/** Todo 分類アイコンの許可リスト（SSOT） */
export const TODO_ICONS = [
  { emoji: "✨", title: "feature" },
  { emoji: "🐛", title: "bug" },
  { emoji: "🔧", title: "fix" },
  { emoji: "♻️", title: "refactor" },
  { emoji: "📝", title: "docs" },
  { emoji: "⚡", title: "perf" },
  { emoji: "🧪", title: "test" },
  { emoji: "🚀", title: "deploy" },
  { emoji: "💡", title: "idea" },
  { emoji: "🎨", title: "style" },
] as const;

/** TODO_ICONS から導出した許可 emoji の集合 */
const todoIconSet: ReadonlySet<string> = new Set(TODO_ICONS.map((ic) => ic.emoji));

/** Todo の zod スキーマ */
export const todoSchema = z.object({
  id: z.string(),
  body: z.string(),
  icon: z
    .string()
    .refine((s) => todoIconSet.has(s))
    .optional()
    .catch(undefined),
  worktreeDir: z.string().optional(),
  createdAt: z.string(),
});

/** Todo アイテム */
export type Todo = z.infer<typeof todoSchema>;

/** ファイルごとの診断結果 */
/** CLI からのパス指定を解決した選択対象 */
export interface OpenTargetSelection {
  kind: "file" | "directory";
  /** activeDir からの相対パス */
  relPath: string;
}

/** VOICEVOX 音声合成の設定 */
export interface VoicevoxConfig {
  enabled: boolean;
  speedScale: number;
  volumeScale: number;
}

/** アプリのグローバル設定 */
export interface AppConfig {
  voicevox?: VoicevoxConfig;
}

export interface FileDiagnostics {
  /** プロジェクトルートからの相対パス */
  relPath: string;
  diagnostics: LspDiagnostic[];
}

/** git log のコミット情報 */
export interface GitCommit {
  /** 完全なコミットハッシュ */
  hash: string;
  /** 短縮ハッシュ（7文字） */
  shortHash: string;
  /** 親コミットのハッシュ（マージコミットは複数） */
  parents: string[];
  /** 著者名 */
  author: string;
  /** コミット日時（Unix timestamp） */
  date: number;
  /** コミットメッセージ（1行目） */
  message: string;
  /** 参照名（ブランチ名、タグ、HEAD 等） */
  refs: string[];
}

export type GozdRPC = {
  bun: RPCSchema<{
    requests: {
      ptySpawn: {
        params: { dir: string; cols: number; rows: number };
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
      /** 絶対パスでファイルを読み取る（ワークスペース外のファイル用） */
      fsReadFileAbsolute: {
        params: { absolutePath: string };
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
      /** git log でコミット履歴を取得（現在ブランチ + main） */
      gitLog: {
        params: { maxCount?: number };
        response: GitCommit[];
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
      /** worktree を作成する */
      createWorktree: {
        params: { worktreeDir: string; branch: string };
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
      /** Todo 一覧を取得 */
      todoList: {
        params: undefined;
        response: Todo[];
      };
      /** Todo を追加（worktreeDir 指定で worktree に紐づけ可能） */
      todoAdd: {
        params: { body: string; icon?: string; worktreeDir?: string };
        response: Todo;
      };
      /** Todo の body と icon を更新 */
      todoUpdate: {
        params: { id: string; body: string; icon?: string };
        response: Todo;
      };
      /** Todo を削除 */
      todoRemove: {
        params: { id: string };
        response: void;
      };
      /** Todo に worktree を作成して紐づける */
      createWorktreeWithTodo: {
        params: { id: string; worktreeDir: string; branch: string };
        response: { todo: Todo; worktree: WorktreeEntry };
      };
      /** 表示対象ディレクトリを切り替える（worktree 選択） */
      switchDir: {
        params: { dir: string };
        response: { dir: string; fileServerBaseUrl: string };
      };
      /** グローバル設定を読み込む */
      configLoad: {
        params: undefined;
        response: AppConfig;
      };
      /** グローバル設定を保存する */
      configSave: {
        params: AppConfig;
        response: void;
      };
      /** VOICEVOX アプリを起動する。インストール済みなら true、未インストールなら false */
      voicevoxLaunch: {
        params: undefined;
        response: boolean;
      };
      /** VOICEVOX Engine の起動状態を確認する */
      voicevoxCheckEngine: {
        params: undefined;
        response: boolean;
      };
      /** VOICEVOX Engine で音声合成し、WAV を base64 で返す */
      voicevoxSpeak: {
        params: { text: string; speedScale: number; volumeScale: number; speakerId: number };
        response: string | undefined;
      };
    };
    messages: {
      ptyWrite: { id: number; data: string };
      ptyResize: { id: number; cols: number; rows: number };
      ptyKill: { id: number };
      openExternal: { url: string };
      windowClose: void;
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
      gozdOpen: {
        dir: string;
        selection?: OpenTargetSelection;
        fileServerBaseUrl: string;
        channel: string;
        repoName: string;
        /** 既存ウィンドウ再利用時に切り替える worktree ディレクトリ。renderer 側で switchDir を呼ぶ */
        switchToDir?: string;
      };
      gozdHook: { event: string; payload: Record<string, unknown> };
      /** LSP 診断結果の更新（ファイル単位） */
      lspDiagnostics: FileDiagnostics;
    };
  }>;
};
