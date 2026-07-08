// Claude Code が ~/.claude/projects/<cwd エンコード>/<session_id>.jsonl に書き出す
// セッションログ (JSONL) の解決・読み取り。Swift 版 `Claude/ClaudeSessionLog.swift` の対応物。
//
// 解決方式: session_id (UUID) を ~/.claude/projects/*/<session_id>.jsonl で解決する。
// cwd → ディレクトリ名のエンコード規則は Claude 側の内部仕様で将来変わりうるため
// gozd 側で再構成しない。fork で別ファイルに分裂したセッションも自分の session_id を
// ファイル名に持つため、この解決で確実に 1 ファイルへ辿れる。
//
// Task ツールの subagent は <projectDir>/<session_id>/subagents/agent-<agentId>.jsonl、
// Workflow の subagent はさらに 1 階層深い subagents/workflows/<wf_id>/agent-*.jsonl に
// 記録される。workflow agent の表示名 / phase は <projectDir>/<session_id>/workflows/
// <wf_id>.json の workflowProgress から agentId をキーに JOIN する。

import type { ReviveSessionInfo } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { gozdWorktreesRoot, resolveProjectKey } from "../taskStore";

interface ClaudeSessionLogEntry {
  kind: "main" | "subagent";
  id: string; // main は session_id、subagent は agent_id
  label: string; // subagent の meta.json description。main は空
  agentType: string; // subagent の meta.json agentType。main は空
  path: string;
  content: string;
  // subagent を spawn した main 側 Agent tool_use の id (meta.json の toolUseId)。main は空
  parentToolUseId: string;
  // subagent の名前 (meta.json の name)。名前なし起動 / main は空
  name: string;
  // workflow agent が属する workflow run の id (wf_xxx)。非 workflow subagent / main は空
  workflowRunId: string;
  // workflow の表示名 (wf json の workflowName)。非 workflow subagent / main は空
  workflowName: string;
  // workflow agent の phase 名 (workflowProgress の phaseTitle)。非 workflow subagent / main は空
  phaseTitle: string;
}

export interface ClaudeSessionLogResult {
  found: boolean;
  entries: ClaudeSessionLogEntry[];
  // renderer が fsWatch を張る dir。非空なら実在を保証する。
  //   - found:                       main jsonl の親 dir (~/.claude/projects/<encoded>/)
  //   - !found && projectsDir 実在:  ~/.claude/projects/ (projects 親)。当該 sessionId の
  //                                  JSONL が後で書かれたら fsChange 経由で renderer が
  //                                  再 load し、found に転じたら specific dir に張り替える
  //   - !found && projectsDir 不在:  空文字。Claude 未起動環境などで renderer 側で error
  //                                  化する (silent fallback を持たない)
  watchDir: string;
}

/** production の本番 projectsDir。`~/.claude/projects/` */
function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** production の gozd worktrees root。SSOT は `taskStore.gozdWorktreesRoot`（ensureWorktreePath と共有）。 */
function defaultWorktreesRoot(): string {
  return gozdWorktreesRoot();
}

/** session_id を path 結合に渡す前の入力ゲート。UUID 構成文字 ([0-9a-fA-F-]) のみ許可し、
 * `/` や `..` 経由の path traversal を構造的に塞ぐ */
function isSafeSessionId(sessionId: string): boolean {
  if (sessionId === "") return false;
  return /^[0-9a-fA-F-]+$/.test(sessionId);
}

/** UTF-8 file を文字列で読む。読めなければ undefined */
function readText(path: string): string | undefined {
  const result = tryCatch(() => readFileSync(path, "utf8"));
  return result.ok ? result.value : undefined;
}

function isDirectory(path: string): boolean {
  const result = tryCatch(() => statSync(path).isDirectory());
  return result.ok && result.value;
}

/** dir 直下のエントリ名一覧（hidden 除外）。dir 不在 / 読み取り不能は空配列 */
function listDir(dir: string): string[] {
  const result = tryCatch(() => readdirSync(dir));
  if (!result.ok) return [];
  return result.value.filter((name) => !name.startsWith("."));
}

interface AgentMeta {
  agentType: string;
  description: string;
  toolUseId: string;
  name: string;
}

/** agent-<id>.jsonl に対応する agent-<id>.meta.json から表示メタを読む */
function readMeta(agentFile: string): AgentMeta {
  const metaPath = agentFile.replace(/\.jsonl$/, ".meta.json");
  // meta.json 不在は正常系 (古い subagent / 未生成) なので無言で空ラベルに倒す
  if (!existsSync(metaPath)) return { agentType: "", description: "", toolUseId: "", name: "" };
  // ファイルは在るのに読めない / parse 失敗は異常なので観察ログを残す
  const parsed = tryCatch(() => JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    console.error(`[ClaudeSessionLog] subagent meta decode failed: ${metaPath}`);
    return { agentType: "", description: "", toolUseId: "", name: "" };
  }
  const obj = parsed.value;
  const meta: AgentMeta = {
    agentType: typeof obj.agentType === "string" ? obj.agentType : "",
    description: typeof obj.description === "string" ? obj.description : "",
    toolUseId: typeof obj.toolUseId === "string" ? obj.toolUseId : "",
    name: typeof obj.name === "string" ? obj.name : "",
  };
  // subagent は必ず Agent tool で spawn されるため meta.json には toolUseId があるはず。
  // 欠落は meta スキーマ drift の兆候。main の Agent 行と紐付けできず silent に外れるため、
  // 握り潰さず観察ログを残す
  if (meta.toolUseId === "") {
    console.error(`[ClaudeSessionLog] subagent meta missing toolUseId: ${metaPath}`);
  }
  return meta;
}

/** agent-<id>.meta.json から agentType だけ読む (workflow agent の fallback 用)。
 * workflow agent の meta.json は agentType しか持たず toolUseId を構造的に欠くため、
 * toolUseId 必須チェックを持つ readMeta を流用すると正常な workflow agent で偽陽性の
 * "missing toolUseId" ログが量産される。agentType だけ読む経路を分けて回避する */
function readAgentTypeFromMeta(agentFile: string): string {
  const metaPath = agentFile.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return "";
  const parsed = tryCatch(() => JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    console.error(`[ClaudeSessionLog] workflow agent meta decode failed: ${metaPath}`);
    return "";
  }
  const agentType = parsed.value.agentType;
  return typeof agentType === "string" ? agentType : "";
}

/** dir 直下の agent-*.jsonl を agentId 昇順 (決定的) で返す */
function listAgentJsonls(dir: string): string[] {
  return listDir(dir)
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

/** "agent-<agentId>.jsonl" のフルパス → "<agentId>" */
function agentIdFromFile(file: string): string {
  return basename(file, ".jsonl").replace(/^agent-/, "");
}

/** subagents ディレクトリ配下の agent-*.jsonl を読む (Task ツール経路) */
function readSubagents(dir: string): ClaudeSessionLogEntry[] {
  const entries: ClaudeSessionLogEntry[] = [];
  for (const file of listAgentJsonls(dir)) {
    const content = readText(file);
    if (content === undefined) {
      // main と非対称に当該 subagent だけ落とす (他 subagent は見せる) が、落とした
      // 事実は silent にせず観察可能にする
      console.error(`[ClaudeSessionLog] subagent jsonl decode failed: ${file}`);
      continue;
    }
    const meta = readMeta(file);
    entries.push({
      kind: "subagent",
      id: agentIdFromFile(file),
      label: meta.description,
      agentType: meta.agentType,
      path: file,
      content,
      parentToolUseId: meta.toolUseId,
      name: meta.name,
      workflowRunId: "",
      workflowName: "",
      phaseTitle: "",
    });
  }
  return entries;
}

interface WorkflowAgentMeta {
  label: string;
  phaseTitle: string;
  agentType: string;
}

/** metaDir/<wf_id>.json を読み、workflowName と agentId→表示メタの Map を返す。
 * 不在 / parse 失敗時は空 (ラベル無しで agent 自体は表示できるため致命ではないが観察ログは残す) */
function readWorkflowProgress(
  metaDir: string,
  wfId: string,
): { workflowName: string; agentMeta: Map<string, WorkflowAgentMeta> } {
  const metaPath = join(metaDir, `${wfId}.json`);
  const agentMeta = new Map<string, WorkflowAgentMeta>();
  if (!existsSync(metaPath)) return { workflowName: "", agentMeta };
  const parsed = tryCatch(() => JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    console.error(`[ClaudeSessionLog] workflow json decode failed: ${metaPath}`);
    return { workflowName: "", agentMeta };
  }
  const obj = parsed.value;
  const workflowName = typeof obj.workflowName === "string" ? obj.workflowName : "";
  if (Array.isArray(obj.workflowProgress)) {
    for (const e of obj.workflowProgress as Record<string, unknown>[]) {
      if (e.type !== "workflow_agent") continue;
      const agentId = typeof e.agentId === "string" ? e.agentId : "";
      if (agentId === "") continue;
      agentMeta.set(agentId, {
        label: typeof e.label === "string" ? e.label : "",
        phaseTitle: typeof e.phaseTitle === "string" ? e.phaseTitle : "",
        // agentType は null のことがある (例: synthesis / judge)。その場合は空文字に倒す
        agentType: typeof e.agentType === "string" ? e.agentType : "",
      });
    }
  }
  return { workflowName, agentMeta };
}

/** subagents/workflows/<wf_id>/agent-*.jsonl を workflow ごと / agentId 昇順 (決定的) で読む。
 * 表示名 / phase / agentType は metaDir/<wf_id>.json の workflowProgress から JOIN する */
function readWorkflowSubagents(dir: string, metaDir: string): ClaudeSessionLogEntry[] {
  // workflows ディレクトリ不在は正常系 (workflow 未使用セッション) なので無言で空配列に倒す
  const wfIds = listDir(dir)
    .filter((name) => name.startsWith("wf_") && isDirectory(join(dir, name)))
    .sort();

  const entries: ClaudeSessionLogEntry[] = [];
  for (const wfId of wfIds) {
    const { workflowName, agentMeta } = readWorkflowProgress(metaDir, wfId);
    for (const file of listAgentJsonls(join(dir, wfId))) {
      const content = readText(file);
      if (content === undefined) {
        console.error(`[ClaudeSessionLog] workflow subagent jsonl decode failed: ${file}`);
        continue;
      }
      const agentId = agentIdFromFile(file);
      const progress = agentMeta.get(agentId);
      // wf json は読めて workflowProgress も解析できた (agentMeta 非空) のに、この agentId
      // だけ載っていない = JOIN ミス。journal / progress の追記タイミング差等で起こりうる
      // 信頼境界外データの兆候なので silent にせず観察ログを残す (ラベル無しで agent 自体は表示)
      if (progress === undefined && agentMeta.size > 0) {
        console.error(`[ClaudeSessionLog] workflow agent missing in progress: wfId=${wfId} agentId=${agentId}`);
      }
      // agentType は workflowProgress 優先、空なら agent の meta.json をフォールバック
      const progressAgentType = progress?.agentType ?? "";
      entries.push({
        kind: "subagent",
        id: agentId,
        label: progress?.label ?? "",
        agentType: progressAgentType === "" ? readAgentTypeFromMeta(file) : progressAgentType,
        path: file,
        content,
        parentToolUseId: "",
        name: "",
        workflowRunId: wfId,
        workflowName,
        phaseTitle: progress?.phaseTitle ?? "",
      });
    }
  }
  return entries;
}

/** session_id から main jsonl + subagents を解決して読む。
 *
 * JSONL は SessionStart 時点では未生成で、最初の UserPromptSubmit で初めて書かれる。
 * !found 時は projects 親を watchDir として返し、renderer はそこに fsWatch を張って
 * 当該 sessionId の JSONL 出現を検知する。
 *
 * `projectsDir` はテスト用の injection 口。production は省略して `~/.claude/projects/` を使う */
export function readClaudeSessionLog(
  sessionId: string,
  projectsDir: string = defaultProjectsDir(),
): ClaudeSessionLogResult {
  // projectsDir 不在 (Claude 未起動環境など) では watchDir を空文字に倒す。renderer 側で
  // notify.error 化され、silent に「watch なし」状態にならない (CLAUDE.md「fallback せずに
  // エラーにする」)。ワイヤ契約「非空 watchDir は実在を保証」をここで担保する
  if (!isDirectory(projectsDir)) {
    return { found: false, entries: [], watchDir: "" };
  }

  if (!isSafeSessionId(sessionId)) {
    return { found: false, entries: [], watchDir: projectsDir };
  }

  const mainFileName = `${sessionId}.jsonl`;
  for (const name of listDir(projectsDir)) {
    const projectDir = join(projectsDir, name);
    if (!isDirectory(projectDir)) continue;
    const mainFile = join(projectDir, mainFileName);
    if (!existsSync(mainFile)) continue;
    const mainContent = readText(mainFile);
    if (mainContent === undefined) {
      // ファイルは在るが読めない。空 content で found=true を返すと parse 側が
      // 空セッションと誤認するため notFound に倒す。落とした事実は観察可能にする
      console.error(`[ClaudeSessionLog] main jsonl decode failed: ${mainFile}`);
      return { found: false, entries: [], watchDir: projectsDir };
    }

    const entries: ClaudeSessionLogEntry[] = [
      {
        kind: "main",
        id: sessionId,
        label: "",
        agentType: "",
        path: mainFile,
        content: mainContent,
        parentToolUseId: "",
        name: "",
        workflowRunId: "",
        workflowName: "",
        phaseTitle: "",
      },
    ];
    // subagents: <projectDir>/<sessionId>/subagents/agent-*.jsonl (Task ツール)
    const sessionDir = join(projectDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    entries.push(...readSubagents(subagentsDir));
    // workflow subagents: <subagents>/workflows/<wf_id>/agent-*.jsonl (Workflow ツール)。
    // ラベルは <sessionDir>/workflows/<wf_id>.json (兄弟) から JOIN する
    entries.push(...readWorkflowSubagents(join(subagentsDir, "workflows"), join(sessionDir, "workflows")));
    return { found: true, entries, watchDir: projectDir };
  }
  return { found: false, entries: [], watchDir: projectsDir };
}

// --- 削除済み worktree のセッション復活 (revive) ---
//
// gozd 製 worktree を消すと cwd パスが失われ `claude --resume` の project key 解決が成立
// しなくなるが、セッションログ (~/.claude/projects/<enc>/<sid>.jsonl) は残る。cwd を worktree
// として作り直せば resume できるため、その候補一覧を列挙する。
//
// 抽出は全行 parse を避け tail (末尾) だけ読む。必要な 3 値はいずれも末尾側に最新値がある:
// cwd (resume の鍵) は全レコード共通の不変値、branch (リネーム後の最終値) は最後の gitBranch、
// title は Claude 生成の要約 (`type:"ai-title"` の aiTitle。gozd の terminalTitle と同一物) の最新値。
// 1 セッションの jsonl は tool 出力込みで数 MB になりうるため、末尾だけ fd で読む。

/** tail 読みの初期 window (bytes)。cwd / branch / title は通常この範囲に収まる。 */
const REVIVE_SCAN_CHUNK = 64 * 1024;
/** window を広げる上限 (bytes)。ここまでで見つからなければ諦める (病的に長い前置きへの上限)。 */
const REVIVE_SCAN_MAX = 4 * 1024 * 1024;
/** title の最大長。表示上の切り詰めは renderer が CSS で行うが、ワイヤ肥大を防ぐため主側でも上限を掛ける。 */
const REVIVE_TITLE_MAX = 200;

/** file のサイズ (bytes)。stat 失敗は 0。 */
function fileSize(path: string): number {
  const result = tryCatch(() => statSync(path).size);
  return result.ok ? result.value : 0;
}

/** file の最終更新時刻 (Unix ミリ秒)。stat 失敗は 0。 */
function fileMtimeMs(path: string): number {
  const result = tryCatch(() => statSync(path).mtimeMs);
  return result.ok ? result.value : 0;
}

/** file の [start, start+length) を UTF-8 文字列で読む。fd を確実に close する。失敗は空文字。 */
function readByteRange(path: string, start: number, length: number): string {
  const result = tryCatch(() => {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const bytes = readSync(fd, buf, 0, length, start);
      return buf.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
  });
  return result.ok ? result.value : "";
}

interface SessionMeta {
  cwd: string;
  branch: string;
  title: string;
  /** 最後のレコードの timestamp (ISO 文字列)。無ければ空文字。 */
  timestamp: string;
}

/** 行群を通して cwd / branch / title / timestamp を集める (いずれも最後に現れた値を採る)。
 *
 * - cwd: どの会話レコードにも載る不変値 (last でよい)
 * - branch: リネームは行順に記録されるため「最後の gitBranch」が最終ブランチ名
 *   (未リネームなら日付、リネーム済みなら PR 名)
 * - title: Claude 生成の要約 (`type:"ai-title"` の aiTitle)。gozd の terminalTitle と同一物で、
 *   毎ターン更新されるため「最後の aiTitle」が最新タイトル。ユーザーの生発話ではない
 * - timestamp: 各レコードの `timestamp` (ISO)。「最後の timestamp」= セッションが最後に動いた時刻。
 *   ファイル mtime と違い FS 操作 (copy / touch / 移動) の影響を受けない内容由来の真値 */
function extractMeta(lines: string[]): SessionMeta {
  let cwd = "";
  let branch = "";
  let title = "";
  let timestamp = "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const result = tryCatch(
      () =>
        JSON.parse(line) as {
          cwd?: unknown;
          gitBranch?: unknown;
          type?: unknown;
          aiTitle?: unknown;
          timestamp?: unknown;
        },
    );
    if (!result.ok) continue;
    const v = result.value;
    if (typeof v.cwd === "string" && v.cwd !== "") cwd = v.cwd;
    if (typeof v.gitBranch === "string" && v.gitBranch !== "") branch = v.gitBranch;
    if (v.type === "ai-title" && typeof v.aiTitle === "string" && v.aiTitle !== "") title = v.aiTitle;
    if (typeof v.timestamp === "string" && v.timestamp !== "") timestamp = v.timestamp;
  }
  const trimmedTitle = title.length > REVIVE_TITLE_MAX ? `${title.slice(0, REVIVE_TITLE_MAX)}…` : title;
  return { cwd, branch, title: trimmedTitle, timestamp };
}

/** file 末尾から cwd / branch / title / timestamp を読む。cwd と branch が揃うまで window を広げる
 * (title / timestamp は best-effort)。全値とも末尾側に最新値があるため tail 読みで足りる。 */
function readSessionMeta(path: string): SessionMeta {
  const size = fileSize(path);
  let window = REVIVE_SCAN_CHUNK;
  while (true) {
    const start = Math.max(0, size - window);
    const text = readByteRange(path, start, size - start);
    const rawLines = text.split("\n");
    // start > 0 のとき先頭は途中からの部分行なので落とす。
    const lines = start > 0 ? rawLines.slice(1) : rawLines;
    const meta = extractMeta(lines);
    if ((meta.cwd !== "" && meta.branch !== "") || start === 0 || window >= REVIVE_SCAN_MAX) {
      return meta;
    }
    window *= 4;
  }
}

/** 指定 repo (dir) 配下の削除済み worktree に紐づく復活可能セッションを列挙する。
 *
 * gozd 製 worktree に限定する: cwd が `~/.local/share/gozd/worktrees/<projectKey>/<leaf>` 配下で、
 * projectKey が呼び出し repo と一致し、かつ cwd が実在しない (= worktree 削除済み) もの。外部 worktree
 * は cwd が gozd スキーム外なので projectKey に帰属付けできず、対象にしない (設計判断)。
 *
 * `projectsDir` / `worktreesRoot` はテスト用の injection 口。production は省略し、それぞれ
 * `~/.claude/projects/` と `~/.local/share/gozd/worktrees/`（ensureWorktreePath の base と同一）を使う。 */
export async function listReviveSessions(
  dir: string,
  projectsDir: string = defaultProjectsDir(),
  worktreesRoot: string = defaultWorktreesRoot(),
): Promise<ReviveSessionInfo[]> {
  if (!isDirectory(projectsDir)) return [];
  const projectKey = await resolveProjectKey(dir);
  const basePrefix = join(worktreesRoot, projectKey) + sep;

  const sessions: ReviveSessionInfo[] = [];
  for (const name of listDir(projectsDir)) {
    const projectDir = join(projectsDir, name);
    if (!isDirectory(projectDir)) continue;
    // sort して代表選定と列挙順を決定論化する (readdir 順は FS 依存。全 jsonl は cwd 共有なので
    // sort は correctness に無害で、代表 1 本の選ばれ方をテスト可能にする)。
    const jsonls = listDir(projectDir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    if (jsonls.length === 0) continue;
    // 同 projectDir の全 jsonl は同じ cwd (Claude の dir エンコード前が同一 dir)。cwd を返せる
    // 最初の 1 本を代表に dir 単位で分類する。先頭が 0 バイト / 破損で cwd を返せなくても
    // dir 全体を捨てず後続 jsonl を試す (代表 1 本の欠損で兄弟セッションを silent drop しない)。
    const metaByPath = new Map<string, SessionMeta>();
    let cwd = "";
    for (const jsonlName of jsonls) {
      const path = join(projectDir, jsonlName);
      const meta = readSessionMeta(path);
      metaByPath.set(path, meta);
      if (meta.cwd !== "") {
        cwd = meta.cwd;
        break;
      }
      console.error(`[listReviveSessions] empty cwd, trying siblings: ${path}`);
    }
    if (cwd === "" || !cwd.startsWith(basePrefix) || existsSync(cwd)) continue;
    const worktreeDir = basename(cwd);
    for (const jsonlName of jsonls) {
      const sessionId = basename(jsonlName, ".jsonl");
      if (!isSafeSessionId(sessionId)) continue;
      const path = join(projectDir, jsonlName);
      // 0 バイト jsonl は session 実体が無く revive しても resume できないため行に出さない
      // (代表選定で cwd 分類から除外したのと整合させ、空 title / 0 KB の blank 行を出さない)。
      const sizeBytes = fileSize(path);
      if (sizeBytes === 0) continue;
      const meta = metaByPath.get(path) ?? readSessionMeta(path);
      // 最終アクティビティは末尾レコードの timestamp (内容由来) を SSOT にする。ISO が無い /
      // parse 不能な病的ケースだけ mtime にフォールバックする (0 で epoch 表示に落とさない)。
      const tsMs = meta.timestamp !== "" ? Date.parse(meta.timestamp) : Number.NaN;
      sessions.push({
        sessionId,
        cwd,
        worktreeDir,
        branch: meta.branch,
        title: meta.title,
        lastActivity: Number.isNaN(tsMs) ? fileMtimeMs(path) : tsMs,
        sizeBytes,
      });
    }
  }
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return sessions;
}
