/**
 * LSP クライアント — tsgo をバックグラウンドで起動し、診断結果を受信する。
 *
 * tsgo は pull diagnostics（textDocument/diagnostic, LSP 3.17）のみ対応。
 * クライアントから明示的にリクエストして診断結果を取得する。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspDiagnostic } from "@orkis/rpc";

// --- JSON-RPC 型 ---

interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspDiagnosticRaw {
  range: LspRange;
  message: string;
  severity?: number;
}

/** textDocument/diagnostic レスポンス */
interface DocumentDiagnosticReport {
  kind: "full" | "unchanged";
  items?: LspDiagnosticRaw[];
  resultId?: string;
}

// --- メッセージのエンコード/デコード ---

const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH_PREFIX = "Content-Length: ";

function encodeMessage(msg: LspMessage): Uint8Array {
  const body = JSON.stringify(msg);
  const bodyBytes = new TextEncoder().encode(body);
  const header = `${CONTENT_LENGTH_PREFIX}${bodyBytes.length}${HEADER_SEPARATOR}`;
  const headerBytes = new TextEncoder().encode(header);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}

// --- LSP クライアント ---

export interface LspClientOptions {
  /** プロジェクトルート（モノレポルート） */
  rootDir: string;
  /** tsgo バイナリの絶対パス */
  tsgoPath: string;
  /** 診断結果の通知コールバック（relPath はプロジェクトルートからの相対パス） */
  onDiagnostics: (relPath: string, diagnostics: LspDiagnostic[]) => void;
  /** エラー通知 */
  onError?: (message: string) => void;
}

export interface LspClient {
  /** ファイルを開いたことを通知（プロジェクトルートからの相対パス） */
  didOpen: (relPath: string, content: string) => void;
  /** ファイル内容の変更を通知（プロジェクトルートからの相対パス、全文送信） */
  didChange: (relPath: string, content: string) => void;
  /** ファイルを閉じたことを通知 */
  didClose: (relPath: string) => void;
  /** プロジェクト内の TS ファイルをスキャンして didOpen + 診断取得 */
  scanProject: () => Promise<void>;
  /** LSP サーバーを終了する */
  shutdown: () => Promise<void>;
}

const TS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt"]);

/**
 * プロジェクト内の TS/JS ファイルを再帰的に収集する。
 * パッケージディレクトリ（node_modules を持つ）に node_modules/.bin/tsgo がない場合、
 * そのサブツリー全体をスキップする（例: apps/renderer は vue-tsc を使うため除外）。
 */
async function collectTsFiles(rootDir: string, relDir = ""): Promise<string[]> {
  const absDir = relDir ? path.join(rootDir, relDir) : rootDir;

  // ルート以外のパッケージディレクトリで tsgo がなければスキップ
  if (relDir !== "") {
    const nodeModulesPath = path.join(absDir, "node_modules");
    if (fs.existsSync(nodeModulesPath)) {
      const tsgoLink = path.join(nodeModulesPath, ".bin", "tsgo");
      if (!fs.existsSync(tsgoLink)) {
        return [];
      }
    }
  }

  const readResult = await fsp.readdir(absDir, { withFileTypes: true }).catch(() => undefined);
  if (readResult === undefined) return [];

  const results: string[] = [];

  for (const entry of readResult) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const sub = await collectTsFiles(rootDir, relPath);
      results.push(...sub);
    } else {
      const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
      if (TS_EXTENSIONS.has(ext)) {
        results.push(relPath);
      }
    }
  }

  return results;
}

/** 診断結果の変換 */
function convertDiagnostics(items: LspDiagnosticRaw[]): LspDiagnostic[] {
  return items.map((d) => ({
    startLine: d.range.start.line,
    startCharacter: d.range.start.character,
    endLine: d.range.end.line,
    endCharacter: d.range.end.character,
    message: d.message,
    severity: d.severity ?? 1,
  }));
}

export function createLspClient(options: LspClientOptions): LspClient {
  const { rootDir, tsgoPath, onDiagnostics, onError } = options;

  let nextId = 1;
  const openFiles = new Set<string>();
  let onInitialized: (() => void) | undefined;
  const initializedPromise = new Promise<void>((resolve) => {
    onInitialized = resolve;
  });

  // バージョンカウンター（didChange ごとにインクリメント）
  const fileVersions = new Map<string, number>();

  // リクエスト → レスポンスの Promise 管理
  const pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();

  // tsgo --lsp --stdio を起動
  const proc = Bun.spawn([tsgoPath, "--lsp", "--stdio"], {
    cwd: rootDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // stderr ログ
  void (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.trim()) {
        console.log(`[lsp/stderr] ${text.trim()}`);
      }
    }
  })();

  // --- stdout パーサー ---

  let buffer = Buffer.alloc(0);
  let expectedLength = -1;

  function processBuffer() {
    for (;;) {
      if (expectedLength < 0) {
        const sepIdx = buffer.indexOf(HEADER_SEPARATOR);
        if (sepIdx < 0) break;

        const headerText = buffer.subarray(0, sepIdx).toString("utf-8");
        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(sepIdx + HEADER_SEPARATOR.length);
          continue;
        }
        expectedLength = Number(match[1]);
        buffer = buffer.subarray(sepIdx + HEADER_SEPARATOR.length);
      }

      if (buffer.length < expectedLength) break;

      const body = buffer.subarray(0, expectedLength).toString("utf-8");
      buffer = buffer.subarray(expectedLength);
      expectedLength = -1;

      try {
        const msg = JSON.parse(body) as LspMessage;
        handleMessage(msg);
      } catch {
        onError?.(`[lsp] failed to parse message: ${body.slice(0, 200)}`);
      }
    }
  }

  void (async () => {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      processBuffer();
    }
    // プロセス終了時に未解決のリクエストをすべて reject する
    const err = new Error("[lsp] process exited with pending requests");
    for (const [, pending] of pendingRequests) {
      pending.reject(err);
    }
    pendingRequests.clear();
  })();

  // --- メッセージハンドラ ---

  function handleMessage(msg: LspMessage) {
    // レスポンス（id があり method がない）
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // サーバーからのリクエスト（id + method がある）→ 空レスポンスを返す
    if (msg.id !== undefined && msg.method !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }

    // サーバーからの通知
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: LspDiagnosticRaw[] };
      const filePath = uriToRelPath(params.uri);
      if (filePath === undefined) return;
      onDiagnostics(filePath, convertDiagnostics(params.diagnostics));
    }
  }

  // --- ユーティリティ ---

  const rootUri = pathToFileURL(rootDir).href;
  /** rootDir のファイル URI プレフィックス（末尾 / 付き） */
  const rootUriPrefix = `${rootUri}/`;

  function relPathToUri(relPath: string): string {
    return pathToFileURL(path.resolve(rootDir, relPath)).href;
  }

  function uriToRelPath(uri: string): string | undefined {
    if (!uri.startsWith(rootUriPrefix)) return undefined;
    const absPath = fileURLToPath(uri);
    return path.relative(rootDir, absPath);
  }

  function send(msg: LspMessage) {
    const encoded = encodeMessage(msg);
    void proc.stdin.write(encoded);
  }

  function sendNotification(method: string, params: unknown) {
    send({ jsonrpc: "2.0", method, params });
  }

  /** リクエストを送り、レスポンスを Promise で受け取る */
  function sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** ファイルの診断結果を pull で取得する */
  async function pullDiagnostics(relPath: string): Promise<void> {
    const uri = relPathToUri(relPath);
    try {
      const result = (await sendRequest("textDocument/diagnostic", {
        textDocument: { uri },
      })) as DocumentDiagnosticReport;

      if (result.kind === "full" && result.items) {
        onDiagnostics(relPath, convertDiagnostics(result.items));
      }
    } catch (e) {
      // 診断取得失敗は致命的ではないのでログだけ
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[lsp] pull diagnostics failed for ${relPath}: ${msg}`);
    }
  }

  // --- initialize ---

  void (async () => {
    try {
      await sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            diagnostic: {
              dynamicRegistration: false,
            },
            publishDiagnostics: {
              relatedInformation: false,
            },
          },
        },
      });
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      console.log("[lsp] initialized");
      onInitialized?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError?.(`[lsp] initialize failed: ${msg}`);
    }
  })();

  // --- 公開 API ---

  const LANG_MAP: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    json: "json",
  };

  return {
    didOpen(relPath: string, content: string) {
      if (openFiles.has(relPath)) return;
      openFiles.add(relPath);
      fileVersions.set(relPath, 1);

      const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
      const languageId = LANG_MAP[ext] ?? "typescript";

      sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: relPathToUri(relPath),
          languageId,
          version: 1,
          text: content,
        },
      });

      // didOpen 後に診断を pull
      void pullDiagnostics(relPath);
    },

    didChange(relPath: string, content: string) {
      if (!openFiles.has(relPath)) {
        this.didOpen(relPath, content);
        return;
      }

      const version = (fileVersions.get(relPath) ?? 1) + 1;
      fileVersions.set(relPath, version);

      sendNotification("textDocument/didChange", {
        textDocument: {
          uri: relPathToUri(relPath),
          version,
        },
        contentChanges: [{ text: content }],
      });

      // didChange 後に診断を pull
      void pullDiagnostics(relPath);
    },

    didClose(relPath: string) {
      if (!openFiles.has(relPath)) return;
      openFiles.delete(relPath);
      fileVersions.delete(relPath);

      sendNotification("textDocument/didClose", {
        textDocument: { uri: relPathToUri(relPath) },
      });
    },

    async scanProject() {
      await initializedPromise;
      const tsFiles = await collectTsFiles(rootDir);
      console.log(`[lsp] scanning ${tsFiles.length} files`);
      for (const relPath of tsFiles) {
        if (openFiles.has(relPath)) continue;
        const absPath = path.resolve(rootDir, relPath);
        const content = await fsp.readFile(absPath, "utf-8").catch(() => undefined);
        if (content === undefined) continue;
        this.didOpen(relPath, content);
      }
    },

    async shutdown() {
      const SHUTDOWN_TIMEOUT_MS = 5000;
      try {
        await Promise.race([
          sendRequest("shutdown", null),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("shutdown timeout")), SHUTDOWN_TIMEOUT_MS),
          ),
        ]);
        sendNotification("exit", null);
      } catch {
        // タイムアウトまたはプロセス異常終了時は強制 kill
      }
      proc.kill();
      await proc.exited;
      console.log("[lsp] shutdown complete");
    },
  };
}
