interface Ok<T> {
  ok: true;
  value: T;
}

interface Err<E = Error> {
  ok: false;
  error: E;
}

type Result<T, E = Error> = Ok<T> | Err<E>;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * try-catch ブロックの代わりに使い、エラーを値として扱えるようにする。
 * Promise を渡すと Promise<Result<T>> を、関数を渡すと Result<T> を返す。
 */
function tryCatch<T>(promise: Promise<T>): Promise<Result<T>>;
function tryCatch<T>(fn: () => T): Result<T>;
function tryCatch<T>(input: Promise<T> | (() => T)): Promise<Result<T>> | Result<T> {
  if (input instanceof Promise) {
    return input.then(
      (value): Ok<T> => ({ ok: true, value }),
      (err): Err => ({ ok: false, error: toError(err) }),
    );
  }

  try {
    const value = input();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export { tryCatch };
export type { Err, Ok, Result };
