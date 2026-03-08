export interface PtyAPI {
  spawn: (cols: number, rows: number) => Promise<number>;
  write: (id: number, data: string) => void;
  resize: (id: number, cols: number, rows: number) => void;
  kill: (id: number) => void;
  onData: (callback: (id: number, data: string) => void) => () => void;
  onExit: (callback: (id: number, exitCode: number) => void) => () => void;
}

export interface FsAPI {
  readDir: (
    relPath: string,
  ) => Promise<Array<{ name: string; isDirectory: boolean; isIgnored: boolean }>>;
}

export interface OrkisAPI {
  pty: PtyAPI;
  fs: FsAPI;
  notifyReady: () => void;
  onOpen: (callback: (dir: string, file?: string) => void) => () => void;
}

declare global {
  interface Window {
    api: OrkisAPI;
  }
}
