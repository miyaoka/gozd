// 配信 URL の契約の回帰テスト。
//
// 配信の権威的な判定 (isUnderPreviewRoot) が意味を持つのは、この層が decode → normalize の順で
// `..` を畳んでいるから。URL パーサは `%2e%2e` を畳まないため、順序を入れ替えると root 判定を
// 素通りする。electron 依存を持たないモジュールに切り出してあるのはここを固定するため。
import { describe, expect, test } from "bun:test";
import { isValidPreviewId, parsePreviewUrl, pathToPreviewUrl } from "./previewUrl";

const PREVIEW_ID = "0b7b1e2c-1111-4222-8333-444455556666";

describe("pathToPreviewUrl / parsePreviewUrl", () => {
  test("`#` や `?` を含むファイル名が round trip する", () => {
    // segment ごとの encode を外すと fragment / query に化けて別パスを指す
    for (const path of ["/repo/a#1.html", "/repo/a?b.html", "/repo/foo bar.html"]) {
      const parsed = parsePreviewUrl(pathToPreviewUrl(path, PREVIEW_ID));
      expect(parsed).toEqual({ previewId: PREVIEW_ID, path });
    }
  });

  test("query は path に混ざらない（iframe の再 load は epoch query で起こす）", () => {
    // 契約の consumer は配信 handler と navigation 防壁の 2 つ。崩れると HTML preview は
    // 初回 load から block され、手がかりは stderr 1 行だけになる
    const parsed = parsePreviewUrl(`${pathToPreviewUrl("/repo/a.html", PREVIEW_ID)}?e=3`);
    expect(parsed).toEqual({ previewId: PREVIEW_ID, path: "/repo/a.html" });
  });

  test("host に preview id が載る（origin が preview ごとに分かれる）", () => {
    const parsed = parsePreviewUrl(pathToPreviewUrl("/repo/a.html", PREVIEW_ID));
    expect(parsed?.previewId).toBe(PREVIEW_ID);
  });

  test("encode された traversal を畳んでから返す", () => {
    // decode → normalize の順を入れ替えると畳まれず、root 判定を素通りする
    const parsed = parsePreviewUrl(`gozd-preview://${PREVIEW_ID}/repo/%2e%2e/%2e%2e/etc/passwd`);
    expect(parsed?.path).toBe("/etc/passwd");
  });

  test("生の `..` も畳む", () => {
    const parsed = parsePreviewUrl(`gozd-preview://${PREVIEW_ID}/repo/docs/../../etc/passwd`);
    expect(parsed?.path).toBe("/etc/passwd");
  });

  test("scheme 違い / host 空 / 非絶対 path は undefined", () => {
    expect(parsePreviewUrl(`file:///etc/passwd`)).toBeUndefined();
    expect(parsePreviewUrl(`https://${PREVIEW_ID}/repo/a.html`)).toBeUndefined();
    expect(parsePreviewUrl("gozd-preview:///repo/a.html")).toBeUndefined();
    expect(parsePreviewUrl("not a url")).toBeUndefined();
  });
});

describe("isValidPreviewId", () => {
  // host は URL パーサが正規化する。登録キー（生の id）と食い違うと配信だけ 403 になり、
  // ログには out-of-root としか出ない。生成元を変えても壊れないよう入口で固定する
  test("crypto.randomUUID の形式は通る", () => {
    expect(isValidPreviewId(PREVIEW_ID)).toBe(true);
  });

  test("正規化で変わる / host に載らない文字は弾く", () => {
    expect(isValidPreviewId("0B7B1E2C-1111")).toBe(false);
    expect(isValidPreviewId("preview_1")).toBe(false);
    expect(isValidPreviewId("preview.1")).toBe(false);
    expect(isValidPreviewId("preview/1")).toBe(false);
    expect(isValidPreviewId("")).toBe(false);
  });
});
