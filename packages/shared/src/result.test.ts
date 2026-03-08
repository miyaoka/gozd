import { describe, expect, test } from "bun:test";
import { tryCatch } from "./result";

describe("tryCatch", () => {
  describe("同期関数", () => {
    test("成功時に Ok を返す", () => {
      const result = tryCatch(() => 42);
      expect(result).toEqual({ ok: true, value: 42 });
    });

    test("例外発生時に Err を返す", () => {
      const result = tryCatch(() => {
        throw new Error("test error");
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("test error");
      }
    });

    test("Error 以外の throw も Error に変換する", () => {
      const result = tryCatch(() => {
        throw "string error";
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("string error");
      }
    });

    test("数値の throw も Error に変換する", () => {
      const result = tryCatch(() => {
        throw 404;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("404");
      }
    });

    test("undefined を返す関数も Ok として扱う", () => {
      const result = tryCatch(() => undefined);
      expect(result).toEqual({ ok: true, value: undefined });
    });
  });

  describe("Promise", () => {
    test("resolve 時に Ok を返す", async () => {
      const result = await tryCatch(Promise.resolve("hello"));
      expect(result).toEqual({ ok: true, value: "hello" });
    });

    test("reject 時に Err を返す", async () => {
      const result = await tryCatch(Promise.reject(new Error("async error")));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("async error");
      }
    });

    test("Error 以外の reject も Error に変換する", async () => {
      const result = await tryCatch(Promise.reject("string reject"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("string reject");
      }
    });
  });
});
