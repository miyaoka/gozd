// rg を実際に spawn して検索できることの契約。fixture を tmpdir に作り、push で
// 集めたマッチと終端 response を検証する。rg 実バイナリ（@vscode/ripgrep）に依存する。

import type { TextSearchMatchPush } from "@gozd/rpc";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchText } from "./ripgrepSearch";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gozd-search-"));
  await writeFile(join(dir, "a.ts"), "const foo = 1;\nconst bar = 2;\n");
  await writeFile(join(dir, "b.ts"), "function foo() {}\n");
  await writeFile(join(dir, "c.md"), "foo in markdown\n");
  // .git 配下に検索語を含むファイルを置き、既定除外で外れることを確認する
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "config"), "foo in git config\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function collect() {
  const pushes: TextSearchMatchPush[] = [];
  const push = (type: string, payload: unknown): void => {
    if (type === "textSearchMatch") pushes.push(payload as TextSearchMatchPush);
  };
  const lines = () => pushes.flatMap((p) => p.lines);
  const matches = () => lines().filter((l) => !l.isContext);
  return { push, lines, matches };
}

test("固定文字列 foo が全ファイルからヒットする", async () => {
  const { push, matches } = collect();
  const res = await searchText({ searchId: "s1", dir, query: { pattern: "foo" } }, push);
  expect(res.searchId).toBe("s1");
  expect(res.limitHit).toBe(false);
  const paths = matches()
    .map((m) => m.path)
    .sort();
  expect(paths).toEqual(["a.ts", "b.ts", "c.md"]);
});

test(".git 配下は既定除外で結果に出ない", async () => {
  const { push, matches } = collect();
  await searchText({ searchId: "sgit", dir, query: { pattern: "foo" } }, push);
  const paths = matches().map((m) => m.path);
  expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  // 通常ファイルは出る（除外が効きすぎていない）
  expect(paths).toContain("a.ts");
});

test("include glob で対象を絞れる", async () => {
  const { push, matches } = collect();
  await searchText(
    { searchId: "s2", dir, query: { pattern: "foo" }, options: { includes: ["*.ts"] } },
    push,
  );
  const paths = matches()
    .map((m) => m.path)
    .sort();
  expect(paths).toEqual(["a.ts", "b.ts"]);
});

test("マッチ範囲の列が正しい（a.ts の const foo）", async () => {
  const { push, matches } = collect();
  await searchText(
    { searchId: "s3", dir, query: { pattern: "foo" }, options: { includes: ["a.ts"] } },
    push,
  );
  const [match] = matches();
  expect(match?.line).toBe(0);
  expect(match?.text).toBe("const foo = 1;");
  expect(match?.isContext).toBe(false);
  expect(match?.ranges[0]).toEqual({ startColumn: 6, endColumn: 9 });
});

test("surroundingContext で前後の文脈行が isContext:true で届く", async () => {
  const { push, lines, matches } = collect();
  // a.ts は "const foo"(行0) / "const bar"(行1)。bar を検索し前後1行の文脈を取る
  await searchText(
    {
      searchId: "s5",
      dir,
      query: { pattern: "bar" },
      options: { includes: ["a.ts"], surroundingContext: 1 },
    },
    push,
  );
  // マッチは bar 行のみ、文脈として foo 行が isContext で来る
  expect(matches().map((m) => m.line)).toEqual([1]);
  const context = lines().find((l) => l.isContext);
  expect(context?.line).toBe(0);
  expect(context?.text).toBe("const foo = 1;");
  expect(context?.ranges).toEqual([]);
});

test("maxResults 到達で limitHit（context は上限に数えない）", async () => {
  const { push, matches } = collect();
  const res = await searchText(
    { searchId: "s4", dir, query: { pattern: "foo" }, options: { maxResults: 1 } },
    push,
  );
  expect(res.limitHit).toBe(true);
  expect(matches().length).toBeGreaterThanOrEqual(1);
});
