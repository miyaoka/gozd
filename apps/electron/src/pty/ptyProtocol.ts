// main（ptyClient）↔ utilityProcess（ptyHost）間の message 契約。
// 純粋な型のみ（runtime 依存なし）。両端が同型を参照して JSON 相当の構造化 message を交換する。
//
// 隔離の目的: node-pty の exit callback（native waitpid → ThreadSafeFunction）は、子の reap が
// アプリ終了時の env teardown（node::FreeEnvironment → CleanupHandles → uv_run で drain）と
// 競合すると、破壊中 isolate 上で `cb.Call` が失敗し node-addon-api が二重 throw → SIGABRT する。
// これは in-process では原理的に消せない（VS Code microsoft/vscode#243952 も未解決）。よって
// node-pty の IPty を丸ごと別プロセス（別アドレス空間）へ移し、crash する env を使い捨ての
// host に閉じ込める。main は host の exit を観測して cleanly quit する（VS Code ptyHost モデル）。
//
// id は PTY 単位で main（routes.ts）が採番する ptyId をそのまま使う。

/** main → host: PTY のライフサイクル操作 + flow control の ack。 */
export type HostToPtyMessage =
  | {
      type: "spawn";
      id: number;
      executable: string;
      /** node-pty 流儀の args（argv[0] を除いた残り）。slice は呼び出し側で済ませて渡す */
      args: string[];
      env: Record<string, string>;
      cwd: string;
      cols: number;
      rows: number;
    }
  | { type: "write"; id: number; data: string }
  | { type: "resize"; id: number; cols: number; rows: number }
  /** 単一端末クローズ。host が kill + ptmx close（tty hangup で foreground group を掃除）する */
  | { type: "kill"; id: number }
  /** flow control: main が renderer へ転送し終えた文字数を返す。host はこれで pause/resume を解く */
  | { type: "ack"; id: number; charCount: number };

/** host → main: spawn 結果 / data / exit / 内部観測ログ。 */
export type PtyToHostMessage =
  /** pid は portScanner の shell pid → worktree 帰属に使うため spawn 応答で返す */
  | { type: "spawned"; id: number; pid: number }
  | { type: "spawnError"; id: number; message: string }
  | { type: "data"; id: number; text: string }
  /** node-pty onExit。signal 優先で renderer の PtyExitReason に変換するのは main 側 */
  | { type: "exit"; id: number; exitCode: number; signal: number }
  /** 隔離プロセス内部の観測ログ。main が event-log（logEvent）へ転送する。
   * stderr は packaged で見えないため host からは使わない（watcher と同じ規律） */
  | { type: "log"; channel: string; label: string; detail: string };
