// lint gate の宣言を機械検査する。
//
// ここで見る 2 種類の宣言は、壊れても他のどの検査にも掛からない。lint は走り、出力も出て、
// exit code は 0 のままになる。壊れたこと自体を落とせるのはこのテストだけ。
//
// - 違反を exit code に載せる宣言: 消えると repo 全体の lint gate が無音で開く
// - root runner の除外: CI と pre-commit の 2 箇所にある pnpm-workspace.yaml の写し。どちらも
//   glob は repo 全体に届く形なので、置き場が増えたときに書き漏らすと workspace を拾い、
//   同じ違反が root と workspace の 2 レーンから出る

import { YAML } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

const read = (...segments: string[]): string => readFileSync(join(repoRoot, ...segments), "utf8");

/** `pnpm-workspace.yaml` の `packages:` が列挙する glob。workspace の置き場の SSOT */
function workspaceGlobs(): string[] {
  const workspace = YAML.parse(read("pnpm-workspace.yaml")) as { packages?: string[] };
  return workspace.packages ?? [];
}

/** workspace が置かれる親ディレクトリ。除外はこの単位で宣言する */
function workspaceParents(): string[] {
  return workspaceGlobs().map((glob) => {
    const [parent = ""] = glob.split("/");
    return parent;
  });
}

/** root の lint スクリプト */
function rootLintScript(): string {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  return pkg.scripts?.lint ?? "";
}

type LefthookJob = {
  name?: string;
  root?: string;
  glob?: string;
  exclude?: string[];
  run?: string;
  group?: { jobs?: LefthookJob[] };
};

/** 入れ子の深さに依存せず job を名前で引く。group の階層は lefthook 側の都合で動く */
function findJob(jobs: LefthookJob[], name: string): LefthookJob | undefined {
  for (const job of jobs) {
    if (job.name === name) return job;
    const found = findJob(job.group?.jobs ?? [], name);
    if (found) return found;
  }
  return undefined;
}

function preCommitJobs(): LefthookJob[] {
  const lefthook = YAML.parse(read("lefthook.yml")) as {
    "pre-commit"?: { jobs?: LefthookJob[] };
  };
  return lefthook["pre-commit"]?.jobs ?? [];
}

/** pre-commit で root runner を担うジョブ */
function rootJob(): LefthookJob | undefined {
  return findJob(preCommitJobs(), "lint-root");
}

/** group を展開した、コマンドを持つジョブの一覧。group の root は子のジョブに引き継ぐ */
function flattenJobs(jobs: LefthookJob[], parentRoot?: string): LefthookJob[] {
  return jobs.flatMap((job) => {
    const root = job.root ?? parentRoot;
    if (job.group) return flattenJobs(job.group.jobs ?? [], root);
    return [{ ...job, root }];
  });
}

/** repo root と pnpm-workspace.yaml が列挙する workspace。`dir` は repo root からの相対（root は "."） */
function workspaces(): { dir: string; scripts: Record<string, string> }[] {
  const dirs = [
    ".",
    ...workspaceGlobs().flatMap((glob) =>
      [...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: repoRoot })].map((path) =>
        path.replace(/\/package\.json$/, ""),
      ),
    ),
  ];
  return dirs.map((dir) => {
    const pkg = JSON.parse(read(dir, "package.json")) as { scripts?: Record<string, string> };
    return { dir, scripts: pkg.scripts ?? {} };
  });
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  return result.stdout.toString().split("\n").filter(Boolean);
}

/** lefthook のジョブ定義から repo root の `.`（root 指定なし）か workspace のパスを取り出す */
function jobDir(job: LefthookJob): string {
  return job.root ? job.root.replace(/\/$/, "") : ".";
}

/**
 * ジョブが受け取る追跡済みファイル。lefthook は root でファイルを root 配下に絞り、glob と
 * exclude は root に関係なく repo root からのパスに当てる
 */
function filesForJob(job: LefthookJob, files: string[]): string[] {
  const dir = jobDir(job);
  const glob = new Bun.Glob(job.glob ?? "**/*");
  const excludes = (job.exclude ?? []).map((pattern) => new Bun.Glob(pattern));
  return files.filter(
    (file) =>
      (dir === "." || file.startsWith(`${dir}/`)) &&
      glob.match(file) &&
      !excludes.some((exclude) => exclude.match(file)),
  );
}

/** pre-commit が実行すべき検査と、それを実行するジョブの run の見分け方 */
const CHECKS: { script: string; runs: RegExp }[] = [
  { script: "typecheck", runs: /\btypecheck\b/ },
  { script: "lint", runs: /\b(lint|oxlint|eslint)\b|\bfix:staged\b/ },
  { script: "test", runs: /\btest\b/ },
];

describe("lint gate", () => {
  test("違反は exit code に出る", () => {
    const config = JSON.parse(read(".oxlintrc.json")) as {
      options?: { denyWarnings?: boolean };
    };
    expect(config.options?.denyWarnings).toBe(true);
  });
});

describe("lint の走査範囲", () => {
  // 下の 2 つは workspaceParents() が空を返しても「除外漏れなし」として通る。置き場の取り出しが
  // 空振りしている状態と、本当に漏れが無い状態を撃ち分けるため、土台を先に固定する
  test("workspace の置き場を pnpm-workspace.yaml から取り出せる", () => {
    const globs = workspaceGlobs();
    expect(globs).toContain("apps/*");
    expect(globs).toContain("packages/*");
    // glob が指す先に実在の workspace があることまで見る（キーは読めたが実体が消えている
    // 状態を通さない）
    for (const parent of workspaceParents()) {
      expect(existsSync(join(repoRoot, parent))).toBe(true);
    }
  });

  // root runner の除外は CI（package.json）と pre-commit（lefthook.yml）の 2 箇所に写しがあり、
  // どちらも glob が repo 全体に届く形なので、置き場が増えたときに書き漏らすと拾ってしまう
  test("CI の root runner は workspace を走査しない", () => {
    const rootLint = rootLintScript();
    const uncovered = workspaceParents().filter(
      (parent) => !rootLint.includes(`--ignore-pattern '${parent}/**'`),
    );
    expect(uncovered).toEqual([]);
  });

  // ジョブが引けないと除外も空になり、下の検査は「全部が除外漏れ」として落ちる。リネームと
  // 書き漏らしを撃ち分けるため、ジョブの所在を先に固定する
  test("pre-commit の root ジョブを lefthook.yml から引ける", () => {
    expect(rootJob()).toBeDefined();
  });

  test("pre-commit の root runner は workspace を走査しない", () => {
    const excludes = rootJob()?.exclude ?? [];
    const uncovered = workspaceParents().filter((parent) => !excludes.includes(`${parent}/**`));
    expect(uncovered).toEqual([]);
  });
});

// CI は各 workspace の typecheck / lint / test スクリプトを実行する。pre-commit に対応する
// ジョブが無いか、ジョブの glob が何にも当たらないと、その workspace の違反は CI で初めて見つかる。
// glob が当たらないジョブは lefthook が黙ってスキップするので、走らないことに誰も気づけない
describe("pre-commit の workspace 網羅", () => {
  // 下の検査は workspaces() が空でも「欠けが無い」として通る。取り出しの空振りを撃ち分ける
  test("workspace と追跡ファイルを取り出せる", () => {
    const dirs = workspaces().map((workspace) => workspace.dir);
    expect(dirs).toContain(".");
    expect(dirs).toContain("apps/electron");
    expect(dirs).toContain("packages/shared");
    expect(trackedFiles()).toContain("lefthook.yml");
  });

  test("CI が実行する検査ごとに、ファイルに当たる pre-commit のジョブがある", () => {
    const jobs = flattenJobs(preCommitJobs());
    const files = trackedFiles();
    const missing = workspaces().flatMap(({ dir, scripts }) =>
      CHECKS.filter(({ script }) => script in scripts)
        .filter(
          ({ runs }) =>
            !jobs.some(
              (job) =>
                jobDir(job) === dir &&
                runs.test(job.run ?? "") &&
                filesForJob(job, files).length > 0,
            ),
        )
        .map(({ script }) => `${dir}: ${script}`),
    );
    expect(missing).toEqual([]);
  });
});
