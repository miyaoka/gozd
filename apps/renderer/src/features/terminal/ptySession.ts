import { tryCatch } from "@gozd/shared";
import { terminalScrollback } from "./terminalConfig";

/** PTY セッション。store が所有し、コンポーネントの mount/unmount を跨いで維持される */
interface PtySession {
  ptyId: number;
  /** 出力 ring buffer。replay 時に xterm.write() で流す */
  chunks: string[];
  /** 書き込み済み総チャンク数（ring buffer のインデックス計算用） */
  totalChunks: number;
  /** 保持している最古チャンクの通し番号。これより前は容量上限で破棄済み */
  startChunk: number;
  /** 保持中チャンクの合計文字数（PTY_RING_BUFFER_MAX_CHARS との比較用） */
  bufferedChars: number;
  /** PTY 終了済みか */
  exited: boolean;
}

export interface PaneEntry {
  dir: string;
  session?: PtySession;
}

/** ring buffer の容量（チャンク数）。scrollback（行数）とは単位が異なるが、十分な再生データを保持する目安として同じ値を使う */
export const PTY_RING_BUFFER_CAPACITY = terminalScrollback;

/**
 * ring buffer が保持する総文字数の上限。JS string は UTF-16 なのでメモリ占有は約 2 倍のバイト数。
 * チャンクサイズは PTY read 単位次第で数十 B〜数十 KB までばらつくため、チャンク数上限だけでは
 * 総メモリが実質無制限になる（TUI の高頻度再描画で 1 ターミナルあたり 200MB 級。issue #894）。
 * 8Mi 文字 ≈ 16 MiB/台。scrollback 10,000 行（ANSI エスケープ込み）の復元には十分な値
 */
export const PTY_RING_BUFFER_MAX_CHARS = 8 * 1024 * 1024;

/**
 * ring buffer にチャンクを追記する。チャンク数（PTY_RING_BUFFER_CAPACITY）と
 * 総文字数（PTY_RING_BUFFER_MAX_CHARS）の二重上限で、古いチャンクから破棄する。
 * 直近のチャンクは単体で上限を超えていても必ず 1 個残す
 */
function pushChunk(session: PtySession, data: string) {
  // チャンク数が満杯なら、これから上書きする最古チャンクの分を先に差し引く
  if (session.totalChunks - session.startChunk === PTY_RING_BUFFER_CAPACITY) {
    session.bufferedChars -= session.chunks[session.startChunk % PTY_RING_BUFFER_CAPACITY].length;
    session.startChunk++;
  }
  session.chunks[session.totalChunks % PTY_RING_BUFFER_CAPACITY] = data;
  session.totalChunks++;
  session.bufferedChars += data.length;

  // 総文字数上限を超えたら最古チャンクから破棄する。空文字代入は、上書きで
  // ring が一周するまで文字列参照が残り GC できないのを防ぐため
  while (
    session.bufferedChars > PTY_RING_BUFFER_MAX_CHARS &&
    session.totalChunks - session.startChunk > 1
  ) {
    const oldestIdx = session.startChunk % PTY_RING_BUFFER_CAPACITY;
    session.bufferedChars -= session.chunks[oldestIdx].length;
    session.chunks[oldestIdx] = "";
    session.startChunk++;
  }
}

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
  /**
   * RPC: PTY を spawn する。
   * leafId を渡すのは spawn 直前に「この leaf 限定の env オーバーレイ」（例: Claude resume）
   * を呼び出し側が組み立てるため。worktreePath は native 側で session-start hook の紐付けに使う。
   */
  requestPtySpawn: (params: {
    leafId: string;
    dir: string;
    cols: number;
    rows: number;
  }) => Promise<number>;
  /** RPC: PTY を kill する（fire-and-forget） */
  sendPtyKill: (params: { id: number }) => void;
  /** PTY 終了時のコールバック（Claude 状態クリーンアップ等に使う） */
  onPtyCleanup?: (ptyId: number) => void;
  /** PTY spawn 失敗時のコールバック（notify 等に使う）。leafId / dir を載せて UI 通知の手掛かりにする */
  onSpawnError?: (params: { leafId: string; dir: string; error: unknown }) => void;
}

export function createPtySessionManager(deps: PtySessionManagerDeps) {
  const { panes, requestPtySpawn, sendPtyKill, onPtyCleanup, onSpawnError } = deps;

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

    // ring buffer に追記
    pushChunk(entry.session, data);

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
    pushChunk(session, exitMsg);

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
    const result = await tryCatch(requestPtySpawn({ leafId, dir: entry.dir, cols, rows }));
    spawningLeafIds.delete(leafId);

    if (!result.ok) {
      onSpawnError?.({ leafId, dir: entry.dir, error: result.error });
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
      startChunk: 0,
      bufferedChars: 0,
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
      for (let i = session.startChunk; i < session.totalChunks; i++) {
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
