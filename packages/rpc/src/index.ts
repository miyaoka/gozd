import type { RPCSchema } from "electrobun/bun";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isIgnored: boolean;
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
      orkisOpen: { dir: string; file?: string };
      orkisHook: { event: string; payload: Record<string, unknown> };
    };
  }>;
};
