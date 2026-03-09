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
      orkisOpen: { dir: string; file?: string; fileServerBaseUrl: string };
      orkisHook: { event: string; payload: Record<string, unknown> };
      /** LSP 診断結果の更新（ファイル単位） */
      lspDiagnostics: FileDiagnostics;
    };
  }>;
};
