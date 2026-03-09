/**
 * LSP クライアント — tsgo / vue-language-server をバックグラウンドで起動し、診断結果を受信する。
 *
 * - tsgo: pull diagnostics（textDocument/diagnostic, LSP 3.17）
 * - vue: tsserver + @vue/typescript-plugin で semanticDiagnosticsSync を直接取得
 *        Vue Language Server は tsserver bridge として使用（publishDiagnostics は使わない）
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

/** tsserver semanticDiagnosticsSync レスポンスの診断エントリ */
interface TsDiagnostic {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  text: string;
  code: number;
  category: string;
}

/** tsserver のレスポンスメッセージ */
interface TsServerResponse {
  type: string;
  command?: string;
  request_seq?: number;
  success?: boolean;
  body?: unknown;
  message?: string;
}

// --- Content-Length フレーミングパーサー ---

const HEADER_SEPARATOR = "\r\n\r\n";

/**
 * Content-Length フレーミングで区切られたメッセージストリームをパースする。
 * LSP（JSON-RPC）と tsserver の両方で同じフレーミングを使う。
 */
function createFrameParser(onMessage: (body: string) => void) {
  let buf = Buffer.alloc(0);
  let expectedLen = -1;

  return {
    /** 受信したチャンクを追加し、完全なメッセージがあればコールバックを呼ぶ */
    feed(chunk: Uint8Array) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);

      for (;;) {
        if (expectedLen < 0) {
          const sepIdx = buf.indexOf(HEADER_SEPARATOR);
          if (sepIdx < 0) break;
          const headerText = buf.subarray(0, sepIdx).toString("utf-8");
          const match = headerText.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            buf = buf.subarray(sepIdx + HEADER_SEPARATOR.length);
            continue;
          }
          expectedLen = Number(match[1]);
          buf = buf.subarray(sepIdx + HEADER_SEPARATOR.length);
        }
        if (buf.length < expectedLen) break;

        const body = buf.subarray(0, expectedLen).toString("utf-8");
        buf = buf.subarray(expectedLen);
        expectedLen = -1;
        onMessage(body);
      }
    },
  };
}

// --- メッセージのエンコード ---

function encodeLspMessage(msg: LspMessage): Uint8Array {
  const body = JSON.stringify(msg);
  const bodyBytes = new TextEncoder().encode(body);
  const header = `Content-Length: ${bodyBytes.length}${HEADER_SEPARATOR}`;
  const headerBytes = new TextEncoder().encode(header);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}

// --- 診断結果の変換 ---

/** LSP publishDiagnostics の変換（0-based line/character） */
function convertLspDiagnostics(items: LspDiagnosticRaw[]): LspDiagnostic[] {
  return items.map((d) => ({
    startLine: d.range.start.line,
    startCharacter: d.range.start.character,
    endLine: d.range.end.line,
    endCharacter: d.range.end.character,
    message: d.message,
    severity: d.severity ?? 1,
  }));
}

/** tsserver の diagnostic カテゴリ → LSP severity */
const TS_CATEGORY_TO_SEVERITY: Record<string, number> = {
  error: 1,
  warning: 2,
  suggestion: 3,
  message: 4,
};

/** tsserver diagnostics の変換（1-based line/offset → 0-based） */
function convertTsDiagnostics(items: TsDiagnostic[]): LspDiagnostic[] {
  return items.map((d) => ({
    startLine: d.start.line - 1,
    startCharacter: d.start.offset - 1,
    endLine: d.end.line - 1,
    endCharacter: d.end.offset - 1,
    message: d.text,
    severity: TS_CATEGORY_TO_SEVERITY[d.category] ?? 1,
  }));
}

// --- ファイル収集 ---

const TS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);
const VUE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "vue"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt"]);

interface CollectOptions {
  extensions: Set<string>;
  /**
   * パッケージディレクトリで特定の bin が必要な場合のコマンド名。
   * 指定すると、node_modules/.bin/<binName> が存在しないパッケージはスキップする。
   */
  requiredBin?: string;
}

async function collectFiles(
  rootDir: string,
  options: CollectOptions,
  relDir = "",
): Promise<string[]> {
  const absDir = relDir ? path.join(rootDir, relDir) : rootDir;

  if (relDir !== "" && options.requiredBin) {
    const nodeModulesPath = path.join(absDir, "node_modules");
    if (fs.existsSync(nodeModulesPath)) {
      const binLink = path.join(nodeModulesPath, ".bin", options.requiredBin);
      if (!fs.existsSync(binLink)) {
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
      const sub = await collectFiles(rootDir, options, relPath);
      results.push(...sub);
    } else {
      const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
      if (options.extensions.has(ext)) {
        results.push(relPath);
      }
    }
  }

  return results;
}

// --- stderr ログ読み取り ---

function pipeStderr(stream: ReadableStream<Uint8Array>, label: string) {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.trim()) {
        console.log(`[lsp:${label}/stderr] ${text.trim()}`);
      }
    }
  })();
}

// --- tsserver bridge ---

interface TsServerBridge {
  /** tsserver にファイルを開く */
  openFile: (absPath: string, content: string) => void;
  /** tsserver にファイル変更を通知（全文置換）。レスポンスを待って返す */
  changeFile: (absPath: string, content: string) => Promise<unknown>;
  /** tsserver にファイルを閉じる */
  closeFile: (absPath: string) => void;
  /** Vue LSP からの tsserver/request をフォワード */
  forwardRequest: (vueRequestId: number, command: string, args: unknown) => void;
  /** semanticDiagnosticsSync で診断を取得 */
  getDiagnostics: (absPath: string) => Promise<TsDiagnostic[]>;
  /** tsserver プロセスを終了 */
  shutdown: () => Promise<void>;
}

interface TsServerBridgeOptions {
  rootDir: string;
  tsdkPath: string;
  pluginProbeLocation: string;
  /** Vue LSP にレスポンスを送る関数 */
  sendNotification: (method: string, params: unknown) => void;
}

function createTsServerBridge(options: TsServerBridgeOptions): TsServerBridge {
  const { rootDir, tsdkPath, pluginProbeLocation, sendNotification } = options;
  const label = "vue/tsserver";

  let seq = 1;
  /** bridge 用: tsserver seq → Vue LSP request id */
  const bridgePending = new Map<number, number>();
  /** 自前リクエスト用: tsserver seq → resolve/reject */
  const ownPending = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (error: Error) => void }
  >();

  const tsserverPath = path.join(tsdkPath, "tsserver.js");
  const proc = Bun.spawn(
    [
      "node",
      tsserverPath,
      "--disableAutomaticTypingAcquisition",
      "--globalPlugins",
      "@vue/typescript-plugin",
      "--pluginProbeLocations",
      pluginProbeLocation,
      "--suppressDiagnosticEvents",
    ],
    {
      cwd: rootDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  pipeStderr(proc.stderr as ReadableStream<Uint8Array>, label);

  // stdout パーサー
  const parser = createFrameParser((body) => {
    try {
      const msg = JSON.parse(body) as TsServerResponse;
      if (msg.type !== "response" || msg.request_seq === undefined) return;

      // 自前リクエストのレスポンス
      const own = ownPending.get(msg.request_seq);
      if (own) {
        ownPending.delete(msg.request_seq);
        if (msg.success) {
          own.resolve(msg.body);
        } else {
          own.reject(new Error(msg.message ?? "tsserver request failed"));
        }
      }

      // Vue LSP bridge 用のレスポンス
      const vueRequestId = bridgePending.get(msg.request_seq);
      if (vueRequestId !== undefined) {
        bridgePending.delete(msg.request_seq);
        const responseBody = msg.success ? msg.body : undefined;
        // vscode-languageserver の onNotification は params を spread するので
        // [[id, body]] として送信し、handler の第1引数が [id, body] になるようにする
        sendNotification("tsserver/response", [[vueRequestId, responseBody]]);
      }
    } catch {
      // パース失敗は無視
    }
  });

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value);
    }
    // プロセス終了時に未解決の pending をすべて reject する
    const err = new Error("[tsserver] process exited with pending requests");
    for (const [, pending] of ownPending) {
      pending.reject(err);
    }
    ownPending.clear();
    bridgePending.clear();
  })();

  function writeToStdin(data: string) {
    const writer = proc.stdin;
    if (typeof writer === "number") return;
    void writer.write(data);
  }

  function sendTsCommand(s: number, command: string, args: unknown) {
    writeToStdin(JSON.stringify({ seq: s, type: "request", command, arguments: args }) + "\n");
  }

  function sendWithResponse(command: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const s = seq++;
      ownPending.set(s, { resolve, reject });
      sendTsCommand(s, command, args);
    });
  }

  // tsserver 初期化: configure + tsconfig を開いてプラグインをロードさせる
  const configureSeq = seq++;
  sendTsCommand(configureSeq, "configure", { hostInfo: "orkis" });

  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    const openSeq = seq++;
    sendTsCommand(openSeq, "updateOpen", {
      changedFiles: [],
      closedFiles: [],
      openFiles: [{ file: tsconfigPath, projectRootPath: rootDir }],
    });
  }

  return {
    openFile(absPath, content) {
      const s = seq++;
      sendTsCommand(s, "updateOpen", {
        changedFiles: [],
        closedFiles: [],
        openFiles: [{ file: absPath, fileContent: content }],
      });
    },

    async changeFile(absPath, content) {
      // 全文置換: 一度閉じて開き直す（changedFiles の行番号上限で tsserver がエラーになるため）
      await sendWithResponse("updateOpen", {
        changedFiles: [],
        closedFiles: [absPath],
        openFiles: [],
      });
      await sendWithResponse("updateOpen", {
        changedFiles: [],
        closedFiles: [],
        openFiles: [{ file: absPath, fileContent: content }],
      });
    },

    closeFile(absPath) {
      const s = seq++;
      sendTsCommand(s, "updateOpen", {
        changedFiles: [],
        closedFiles: [absPath],
        openFiles: [],
      });
    },

    forwardRequest(vueRequestId, command, args) {
      const s = seq++;
      bridgePending.set(s, vueRequestId);
      sendTsCommand(s, command, args);
    },

    async getDiagnostics(absPath) {
      const body = await sendWithResponse("semanticDiagnosticsSync", { file: absPath });
      return (body ?? []) as TsDiagnostic[];
    },

    async shutdown() {
      proc.kill();
      await proc.exited;
    },
  };
}

// --- LSP クライアント ---

/** LSP サーバーの種別ごとの起動設定 */
export type LspServerConfig =
  | { kind: "tsgo"; binaryPath: string }
  | { kind: "vue"; serverPath: string; tsdkPath: string; pluginProbeLocation: string };

export interface LspClientOptions {
  /** プロジェクトルート（モノレポルート、または対象パッケージルート） */
  rootDir: string;
  /** LSP サーバーの設定 */
  server: LspServerConfig;
  /** 診断結果の通知コールバック（relPath はプロジェクトルートからの相対パス） */
  onDiagnostics: (relPath: string, diagnostics: LspDiagnostic[]) => void;
  /** エラー通知 */
  onError?: (message: string) => void;
}

export interface LspClient {
  readonly rootDir: string;
  didOpen: (relPath: string, content: string) => void;
  didChange: (relPath: string, content: string) => void;
  didClose: (relPath: string) => void;
  scanProject: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  json: "json",
  vue: "vue",
};

export function createLspClient(options: LspClientOptions): LspClient {
  const { rootDir, server, onDiagnostics, onError } = options;
  const label = server.kind;

  let nextId = 1;
  const openFiles = new Set<string>();
  let onInitialized: (() => void) | undefined;
  const initializedPromise = new Promise<void>((resolve) => {
    onInitialized = resolve;
  });

  const fileVersions = new Map<string, number>();

  // LSP リクエスト → レスポンスの Promise 管理
  const pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();

  // --- LSP サーバープロセス起動 ---

  const spawnArgs =
    server.kind === "tsgo"
      ? [server.binaryPath, "--lsp", "--stdio"]
      : ["node", server.serverPath, "--stdio", `--tsdk=${server.tsdkPath}`];

  const proc = Bun.spawn(spawnArgs, {
    cwd: rootDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (server.kind === "vue") {
    pipeStderr(proc.stderr as ReadableStream<Uint8Array>, label);
  }

  // --- tsserver bridge（vue のみ） ---

  function sendLspNotification(method: string, params: unknown) {
    sendLsp({ jsonrpc: "2.0", method, params });
  }

  const tsbridge =
    server.kind === "vue"
      ? createTsServerBridge({
          rootDir,
          tsdkPath: server.tsdkPath,
          pluginProbeLocation: server.pluginProbeLocation,
          sendNotification: sendLspNotification,
        })
      : undefined;

  // --- LSP stdout パーサー ---

  const lspParser = createFrameParser((body) => {
    try {
      handleLspMessage(JSON.parse(body) as LspMessage);
    } catch {
      onError?.(`[lsp] failed to parse message: ${body.slice(0, 200)}`);
    }
  });

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lspParser.feed(value);
    }
    // プロセス終了時に未解決のリクエストを reject
    const err = new Error("[lsp] process exited with pending requests");
    for (const [, pending] of pendingRequests) {
      pending.reject(err);
    }
    pendingRequests.clear();
  })();

  // --- LSP メッセージハンドラ ---

  function handleLspMessage(msg: LspMessage) {
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

    // サーバーからのリクエスト（id + method）
    if (msg.id !== undefined && msg.method !== undefined) {
      if (msg.method === "workspace/configuration") {
        const params = msg.params as { items: Array<{ section?: string }> };
        const result = params.items.map(({ section }) => {
          if (section?.startsWith("vue.inlayHints.")) return true;
          return null;
        });
        sendLsp({ jsonrpc: "2.0", id: msg.id, result });
      } else {
        sendLsp({ jsonrpc: "2.0", id: msg.id, result: null });
      }
      return;
    }

    // tsserver/request → bridge にフォワード
    if (msg.method === "tsserver/request" && tsbridge) {
      // vscode-languageserver は params を [[id, command, args]] として送信する
      const [inner] = msg.params as [[number, string, unknown]];
      const [id, command, args] = inner;
      tsbridge.forwardRequest(id, command, args);
      return;
    }

    // publishDiagnostics（tsgo のみ使用。vue は tsserver から直接取得する）
    if (msg.method === "textDocument/publishDiagnostics" && !tsbridge) {
      const params = msg.params as { uri: string; diagnostics: LspDiagnosticRaw[] };
      const filePath = uriToRelPath(params.uri);
      if (filePath === undefined) return;
      onDiagnostics(filePath, convertLspDiagnostics(params.diagnostics));
    }
  }

  // --- LSP ユーティリティ ---

  const rootUri = pathToFileURL(rootDir).href;

  function relPathToUri(relPath: string): string {
    return pathToFileURL(path.resolve(rootDir, relPath)).href;
  }

  function uriToRelPath(uri: string): string | undefined {
    if (!uri.startsWith("file://")) return undefined;
    const absPath = fileURLToPath(uri);
    const relPath = path.relative(rootDir, absPath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) return undefined;
    return relPath;
  }

  function sendLsp(msg: LspMessage) {
    void proc.stdin.write(encodeLspMessage(msg));
  }

  function sendLspRequest(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      sendLsp({ jsonrpc: "2.0", id, method, params });
    });
  }

  // --- 診断取得 ---

  /** tsgo: LSP pull diagnostics */
  async function pullLspDiagnostics(relPath: string): Promise<void> {
    try {
      const result = (await sendLspRequest("textDocument/diagnostic", {
        textDocument: { uri: relPathToUri(relPath) },
      })) as DocumentDiagnosticReport;

      if (result.kind === "full" && result.items) {
        onDiagnostics(relPath, convertLspDiagnostics(result.items));
      }
    } catch {
      // 診断取得失敗は致命的ではない
    }
  }

  /** vue: tsserver の semanticDiagnosticsSync で診断取得 */
  async function pullTsServerDiagnostics(relPath: string): Promise<void> {
    if (!tsbridge) return;
    const absPath = path.resolve(rootDir, relPath);
    try {
      const items = await tsbridge.getDiagnostics(absPath);
      onDiagnostics(relPath, convertTsDiagnostics(items));
    } catch {
      // 診断取得失敗は致命的ではない
    }
  }

  function requestDiagnostics(relPath: string) {
    if (tsbridge) {
      void pullTsServerDiagnostics(relPath);
    } else {
      void pullLspDiagnostics(relPath);
    }
  }

  // --- initialize ---

  void (async () => {
    try {
      await sendLspRequest("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            diagnostic: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { configuration: true },
        },
      });
      sendLspNotification("initialized", {});
      onInitialized?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError?.(`[lsp] initialize failed: ${msg}`);
      // 失敗時も resolve して scanProject がハングしないようにする
      onInitialized?.();
    }
  })();

  // --- 公開 API ---

  return {
    rootDir,

    didOpen(relPath, content) {
      if (openFiles.has(relPath)) return;
      openFiles.add(relPath);
      fileVersions.set(relPath, 1);

      const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
      const languageId = LANG_MAP[ext] ?? "typescript";

      sendLspNotification("textDocument/didOpen", {
        textDocument: { uri: relPathToUri(relPath), languageId, version: 1, text: content },
      });

      if (tsbridge) {
        tsbridge.openFile(path.resolve(rootDir, relPath), content);
      }

      requestDiagnostics(relPath);
    },

    didChange(relPath, content) {
      if (!openFiles.has(relPath)) {
        this.didOpen(relPath, content);
        return;
      }

      const version = (fileVersions.get(relPath) ?? 1) + 1;
      fileVersions.set(relPath, version);

      sendLspNotification("textDocument/didChange", {
        textDocument: { uri: relPathToUri(relPath), version },
        contentChanges: [{ text: content }],
      });

      if (tsbridge) {
        // tsserver の変更反映を待ってから診断を取得する
        void tsbridge.changeFile(path.resolve(rootDir, relPath), content).then(() => {
          requestDiagnostics(relPath);
        });
      } else {
        requestDiagnostics(relPath);
      }
    },

    didClose(relPath) {
      if (!openFiles.has(relPath)) return;
      openFiles.delete(relPath);
      fileVersions.delete(relPath);

      sendLspNotification("textDocument/didClose", {
        textDocument: { uri: relPathToUri(relPath) },
      });

      if (tsbridge) {
        tsbridge.closeFile(path.resolve(rootDir, relPath));
      }
    },

    async scanProject() {
      await initializedPromise;
      const collectOptions: CollectOptions =
        server.kind === "tsgo"
          ? { extensions: TS_EXTENSIONS, requiredBin: "tsgo" }
          : { extensions: VUE_EXTENSIONS };
      const files = await collectFiles(rootDir, collectOptions);
      for (const relPath of files) {
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
          sendLspRequest("shutdown", null),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("shutdown timeout")), SHUTDOWN_TIMEOUT_MS),
          ),
        ]);
        sendLspNotification("exit", null);
      } catch {
        // タイムアウトまたはプロセス異常終了時は強制 kill
      }
      proc.kill();
      await proc.exited;
      if (tsbridge) {
        await tsbridge.shutdown();
      }
    },
  };
}
