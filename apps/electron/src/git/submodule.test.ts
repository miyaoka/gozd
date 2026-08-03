import { describe, expect, test } from "bun:test";
import { parseGitmodulesConfig, resolveRelativeOwnerRepo } from "./submodule";

/** `git config -z` の 1 レコード（`<key> LF <value>` を NUL 区切り）を組む */
function records(...pairs: [key: string, value: string][]): string {
  return pairs.map(([key, value]) => `${key}\n${value}\0`).join("");
}

describe("parseGitmodulesConfig", () => {
  test("path / url を submodule 名ごとに畳む", () => {
    const text = records(
      ["submodule.lib.path", "vendor/lib"],
      ["submodule.lib.url", "https://github.com/owner/lib"],
    );
    expect(parseGitmodulesConfig(text)).toEqual(
      new Map([["lib", { path: "vendor/lib", url: "https://github.com/owner/lib" }]]),
    );
  });

  test("name にドットを含んでも property だけを末尾から切り出す", () => {
    // `.gitmodules` の name は既定で path と同じ文字列なので、パスのドットがそのまま name に入る
    const text = records(
      ["submodule.tests/_fixtures/npmx.dev.path", "tests/_fixtures/npmx.dev"],
      ["submodule.tests/_fixtures/npmx.dev.url", "https://github.com/npmx-dev/npmx.dev"],
    );
    expect(parseGitmodulesConfig(text)).toEqual(
      new Map([
        [
          "tests/_fixtures/npmx.dev",
          { path: "tests/_fixtures/npmx.dev", url: "https://github.com/npmx-dev/npmx.dev" },
        ],
      ]),
    );
  });

  test("path / url 以外の property は捨てる", () => {
    const text = records(
      ["submodule.lib.path", "vendor/lib"],
      ["submodule.lib.shallow", "true"],
      ["submodule.lib.branch", "main"],
    );
    expect(parseGitmodulesConfig(text)).toEqual(new Map([["lib", { path: "vendor/lib" }]]));
  });

  test("値に改行を含んでも最初の LF だけを区切りにする", () => {
    const text = records(["submodule.lib.url", "https://example.com/a\nb"]);
    expect(parseGitmodulesConfig(text)).toEqual(
      new Map([["lib", { url: "https://example.com/a\nb" }]]),
    );
  });

  test("submodule 以外の section と空出力は無視する", () => {
    expect(parseGitmodulesConfig(records(["remote.origin.url", "https://example.com"]))).toEqual(
      new Map(),
    );
    expect(parseGitmodulesConfig("")).toEqual(new Map());
  });
});

describe("resolveRelativeOwnerRepo", () => {
  const origin = { owner: "acme", repo: "super" };

  test("`../` は superproject の repo 成分を落として同じ owner 配下を指す", () => {
    expect(resolveRelativeOwnerRepo(origin, "../lib.git")).toEqual({ owner: "acme", repo: "lib" });
    expect(resolveRelativeOwnerRepo(origin, "../lib")).toEqual({ owner: "acme", repo: "lib" });
  });

  test("`../../` は owner まで遡って別 owner を指せる", () => {
    expect(resolveRelativeOwnerRepo(origin, "../../other/lib.git")).toEqual({
      owner: "other",
      repo: "lib",
    });
  });

  test("`./` は下位への降下になり GitHub の owner/repo に収まらない", () => {
    expect(resolveRelativeOwnerRepo(origin, "./lib.git")).toBeUndefined();
  });

  test("遡りすぎて 2 成分に満たない場合は解決しない", () => {
    expect(resolveRelativeOwnerRepo(origin, "../../../lib.git")).toBeUndefined();
  });
});
