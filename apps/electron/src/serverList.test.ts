import { describe, expect, test } from "bun:test";
import { ServerAttribution } from "@gozd/proto";
import { parseLsofOutput } from "./serverList";

describe("parseLsofOutput", () => {
  test("pid ごとに port を集約し昇順にする", () => {
    const output = [
      "p100",
      "cnode",
      "n*:8080",
      "n127.0.0.1:3000",
      "n*:8080",
      "p200",
      "cvite",
      "n[::1]:5173",
      "",
    ].join("\n");
    const entries = parseLsofOutput(output);
    expect(entries).toEqual([
      {
        pid: 100,
        name: "node",
        ports: [3000, 8080],
        attribution: ServerAttribution.SERVER_ATTRIBUTION_EXTERNAL,
        worktreePath: "",
        ptyId: 0,
      },
      {
        pid: 200,
        name: "vite",
        ports: [5173],
        attribution: ServerAttribution.SERVER_ATTRIBUTION_EXTERNAL,
        worktreePath: "",
        ptyId: 0,
      },
    ]);
  });

  test("IPv6 アドレスの port を正しく取り出す", () => {
    const entries = parseLsofOutput("p1\nczsh\nn[fe80::1%lo0]:9999\n");
    expect(entries[0].ports).toEqual([9999]);
  });

  test("空出力は空配列", () => {
    expect(parseLsofOutput("")).toEqual([]);
  });
});
