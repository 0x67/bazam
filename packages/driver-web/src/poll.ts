import { setTimeout as sleep } from "node:timers/promises";

// what Playwright throws when a navigation replaces the page or frame while a read runs; the next read sees the new one
const NAVIGATED = /Execution context was destroyed|Frame was detached/;

/** True when a read failed only because the page navigated under it, such as a form post that redirects. */
export function navigatedDuringRead(error: unknown): boolean {
  return error instanceof Error && NAVIGATED.test(error.message);
}

/**
 * Reads until `ok` accepts the value or `timeoutMs` passes, and returns the last value read with the verdict. A read
 * that a navigation interrupted is tried again; its error is thrown only when no read finished before the time ran out.
 */
export async function poll<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ value: T; ok: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { value: T } | undefined;
  let interrupted: unknown;
  for (;;) {
    try {
      const value = await read();
      if (ok(value)) return { value, ok: true };
      last = { value };
    } catch (error) {
      if (!navigatedDuringRead(error)) throw error;
      interrupted = error;
    }
    if (Date.now() >= deadline) {
      if (last === undefined) throw interrupted;
      return { value: last.value, ok: false };
    }
    await sleep(intervalMs);
  }
}
