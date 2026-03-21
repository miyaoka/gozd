import { tryCatch } from "@gozd/shared";
import { terminalConfig } from "./terminalConfig";

/** PTY セッション。store が所有し、コンポーネントの mount/unmount を跨いで維持される */
export interface PtySession {
  ptyId: number;
  /** 出力 ring buffer。replay 時に xterm.write() で流す */
  chunks: string[];
  /** 書き込み済み総チャンク数（ring buffer のインデックス計算用） */
  totalChunks: number;
  /** PTY 終了済みか */
  exited: boolean;
}

export interface PaneEntry {
  dir: string;
  session?: PtySession;
}

/** ring buffer の容量（チャンク数）。scrollback（行数）とは単位が異なるが、十分な再生データを保持する目安として同じ値を使う */
const PTY_RING_BUFFER_CAPACITY = terminalConfig.scrollback;

/** paneRegistry への session 読み書きアクセサ。store が所有する paneRegistry の session フィールドだけを操作する */
interface PaneSessionAccessor {
  /** leafId に対応するペインの dir と session を返す。存在しなければ undefined */
  getPane: (leafId: string) => PaneEntry | undefined;
  /** leafId に対応するペインの session を設定する */
  setSession: (leafId: string, session: PtySession | undefined) => void;
  /** 全ペインエントリを走査する（HMR 復元用） */
  iterateEntries: () => Iterable<[string, PaneEntry]>;
}

interface PtySessionManagerDeps {
  panes: PaneSessionAccessor;
  /** RPC: PTY を spawn する */
  requestPtySpawn: (params: { dir: string; cols: number; rows: number }) => Promise<number>;
  /** RPC: PTY を kill する（fire-and-forget） */
  sendPtyKill: (params: { id: number }) => void;
  /** PTY データ受信時のコールバック（interrupt 検知等に使う） */
  onDataReceived?: (ptyId: number, data: string) => void;
  /** PTY 終了時のコールバック（Claude 状態クリーンアップ等に使う） */
  onPtyCleanup?: (ptyId: number) => void;
}

export function createPtySessionManager(deps: PtySessionManagerDeps) {
  const { panes, requestPtySpawn, sendPtyKill, onDataReceived, onPtyCleanup } = deps;

  /** leafId → xterm.write コールバック。attach 中のみ存在 */
  const terminalWriters = new Map<string, (data: string) => void>();

  /** ptyId → leafId 逆引き（onPtyData/onPtyExit で高速検索用） */
  const ptyIdToLeafId = new Map<number, string>();

  /** spawn 中の leafId（二重 spawn 防止） */
  const spawningLeafIds = new Set<string>();

  /** ptyId が生存中かどうか */
  function isPtyAlive(ptyId: number): boolean {
    return ptyIdToLeafId.has(ptyId);
  }

  /**
   * paneRegistry から ptyIdToLeafId を再構築する。
   * HMR 時に plain Map が空になるため、Pinia state として残っている
   * paneRegistry の session 情報から逆引きを復元する。
   */
  function rebuildPtyIdMap() {
    ptyIdToLeafId.clear();
    for (const [leafId, entry] of panes.iterateEntries()) {
      if (entry.session === undefined) continue;
      if (entry.session.exited) continue;
      ptyIdToLeafId.set(entry.session.ptyId, leafId);
    }
  }

  /** PTY データを受信したときの処理。RPC 購読コールバックから呼ぶ */
  function handlePtyData(id: number, data: string) {
    const leafId = ptyIdToLeafId.get(id);
    if (leafId === undefined) return;
    const entry = panes.getPane(leafId);
    if (entry?.session === undefined) return;

    // interrupt 検知等の外部コールバック
    onDataReceived?.(id, data);

    // ring buffer に追記
    const session = entry.session;
    const idx = session.totalChunks % PTY_RING_BUFFER_CAPACITY;
    session.chunks[idx] = data;
    session.totalChunks++;

    // attach 中の terminal に即時転送
    const writer = terminalWriters.get(leafId);
    if (writer !== undefined) writer(data);
  }

  /** PTY 終了時の処理。RPC 購読コールバックから呼ぶ */
  function handlePtyExit(id: number) {
    const leafId = ptyIdToLeafId.get(id);
    if (leafId === undefined) return;
    const entry = panes.getPane(leafId);
    if (entry?.session === undefined) return;

    const session = entry.session;
    session.exited = true;

    // ring buffer に終了メッセージを追記
    const exitMsg = "\r\n[Process exited]\r\n";
    const idx = session.totalChunks % PTY_RING_BUFFER_CAPACITY;
    session.chunks[idx] = exitMsg;
    session.totalChunks++;

    const writer = terminalWriters.get(leafId);
    if (writer !== undefined) writer(exitMsg);

    ptyIdToLeafId.delete(id);
    onPtyCleanup?.(id);
  }

  /** PTY を spawn する。生存中 session または spawn 中であれば何もしない */
  async function spawnPty(leafId: string, cols: number, rows: number): Promise<void> {
    const entry = panes.getPane(leafId);
    if (entry === undefined) return;
    // 生存中 session があればスキップ（HMR 再マウント時）
    // exited session は再 spawn を許可する
    if (entry.session !== undefined && !entry.session.exited) return;
    // 二重 spawn 防止（await 中に再マウントされた場合）
    if (spawningLeafIds.has(leafId)) return;

    spawningLeafIds.add(leafId);
    const result = await tryCatch(requestPtySpawn({ dir: entry.dir, cols, rows }));
    spawningLeafIds.delete(leafId);

    if (!result.ok) {
      console.warn("[terminal] ptySpawn failed:", result.error);
      return;
    }

    const ptyId = result.value;

    // spawn 完了前に leaf が削除されていたら即 kill
    const current = panes.getPane(leafId);
    if (current === undefined) {
      sendPtyKill({ id: ptyId });
      return;
    }

    // 別の spawn が先に完了して生存中 session を設定していた場合は即 kill
    if (current.session !== undefined && !current.session.exited) {
      sendPtyKill({ id: ptyId });
      return;
    }

    const session: PtySession = {
      ptyId,
      chunks: Array.from<string>({ length: PTY_RING_BUFFER_CAPACITY }),
      totalChunks: 0,
      exited: false,
    };

    panes.setSession(leafId, session);
    ptyIdToLeafId.set(ptyId, leafId);
  }

  /** PTY を kill し、関連リソースをクリーンアップする */
  function killPty(leafId: string) {
    const entry = panes.getPane(leafId);
    if (entry?.session === undefined) return;

    // 自然終了済み（handlePtyExit で処理済み）なら kill/cleanup をスキップ
    if (!entry.session.exited) {
      sendPtyKill({ id: entry.session.ptyId });
      ptyIdToLeafId.delete(entry.session.ptyId);
      onPtyCleanup?.(entry.session.ptyId);
    }
    terminalWriters.delete(leafId);
    panes.setSession(leafId, undefined);
  }

  /**
   * terminal を PTY セッションに接続する。
   * 既存 session の ring buffer を replay し、以降のデータを即時転送する。
   * @returns detach 用の disposer
   */
  function attachTerminal(leafId: string, writer: (data: string) => void): () => void {
    const entry = panes.getPane(leafId);
    if (entry?.session !== undefined) {
      // ring buffer replay
      const session = entry.session;
      const stored = Math.min(session.totalChunks, PTY_RING_BUFFER_CAPACITY);
      const startIdx = session.totalChunks - stored;
      for (let i = startIdx; i < session.totalChunks; i++) {
        writer(session.chunks[i % PTY_RING_BUFFER_CAPACITY]);
      }
    }

    terminalWriters.set(leafId, writer);

    // disposer は自分が登録した writer のみを削除する（HMR で新旧が入れ替わるため）
    return () => {
      if (terminalWriters.get(leafId) === writer) {
        terminalWriters.delete(leafId);
      }
    };
  }

  return {
    isPtyAlive,
    rebuildPtyIdMap,
    handlePtyData,
    handlePtyExit,
    spawnPty,
    killPty,
    attachTerminal,
  };
}
