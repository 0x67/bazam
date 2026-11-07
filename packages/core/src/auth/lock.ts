import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CredentialKey } from "./cache.ts";

// a holder killed mid-refresh leaves its file behind; a live holder touches its file far more often
const STALE_MS = 2 * 60_000;
const HEARTBEAT_MS = STALE_MS / 4;
// longer than STALE_MS, so a waiter outlasts a holder that hangs
const WAIT_MS = STALE_MS + 30_000;
const POLL_MS = 50;

export class RefreshLockTimeout extends Error {
  /** Undefined when the lock file did not name one. */
  readonly pid: number | undefined;

  constructor(pid: number | undefined) {
    super(`refresh lock held by pid ${pid ?? "unknown"}`);
    this.name = "RefreshLockTimeout";
    this.pid = pid;
  }
}

/**
 * Runs `fn` while holding `<lockDir>/<env>+<identity>+<surface>.lock`, shared by every process on this
 * machine. The holder touches the file while `fn` runs, so a login that waits on a person keeps it.
 * A lock whose pid no longer runs, or untouched for two minutes, is removed.
 */
export async function withRefreshLock<T>(
  lockDir: string,
  key: CredentialKey,
  fn: () => Promise<T>,
  waitMs = WAIT_MS,
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const stem = [key.env, key.identity, key.surface].map(encodeURIComponent).join("+");
  const path = join(lockDir, `${stem}.lock`);
  const content = await takeLock(path, waitMs);
  const heartbeat = setInterval(() => void touch(path), HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(path, content);
  }
}

async function takeLock(path: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const content = holderContent();
    if (await createExclusive(path, content)) return content;
    const holder = await readHolder(path);
    if (holder === undefined) continue;
    if (isStale(holder) && (await removeStale(path, holder))) continue;
    if (Date.now() >= deadline) throw new RefreshLockTimeout(holder.pid);
    await sleep(POLL_MS);
  }
}

/**
 * Removes a stale lock under the guard file `<lock>.takeover`, and only while it still holds what the
 * caller read. Two waiters that judged the same lock stale would otherwise both remove it, the second
 * removing the fresh lock the first had just taken. False when another waiter holds the guard.
 */
async function removeStale(path: string, stale: Holder): Promise<boolean> {
  const guard = `${path}.takeover`;
  if (!(await createExclusive(guard, holderContent()))) {
    // a waiter that died while holding the guard
    const guardHolder = await readHolder(guard);
    if (guardHolder !== undefined && isStale(guardHolder)) await rm(guard, { force: true });
    return false;
  }
  try {
    if ((await readText(path)) === stale.text) await rm(path, { force: true });
    return true;
  } finally {
    await rm(guard, { force: true });
  }
}

async function releaseLock(path: string, content: string): Promise<void> {
  // a holder that hung past STALE_MS may have lost the lock to another process
  if ((await readText(path)) === content) await rm(path, { force: true });
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  // nothing to keep fresh once the file is gone
  await utimes(path, now, now).catch(() => undefined);
}

function holderContent(): string {
  return JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
}

async function createExclusive(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

interface Holder {
  text: string;
  /** Undefined while the holder has created the file but not yet written it. */
  pid: number | undefined;
  ageMs: number;
}

/** Undefined when the lock is gone. */
async function readHolder(path: string): Promise<Holder | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, pid: pidOf(text), ageMs: Date.now() - info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function pidOf(text: string): number | undefined {
  try {
    const { pid } = JSON.parse(text) as { pid?: unknown };
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isStale(holder: Holder): boolean {
  return holder.ageMs > STALE_MS || (holder.pid !== undefined && !isRunning(holder.pid));
}

function isRunning(pid: number): boolean {
  try {
    // signal 0 tests that the process exists without touching it
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs under another user
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
