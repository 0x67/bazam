import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RefreshLockTimeout, withRefreshLock, type CredentialKey } from "../src/auth/index.ts";

const run = promisify(execFile);

const key: CredentialKey = {
  env: "demo",
  identity: "customer",
  surface: "api",
  strategy: "oauth2",
};
const LOCK_FILE = "demo+customer+api.lock";

describe("withRefreshLock", () => {
  let lockDir: string;

  beforeEach(async () => {
    lockDir = await mkdtemp(join(tmpdir(), "lock-test-"));
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  /** Writes the lock file another process would hold. */
  async function writeLock(pid: number, ageMs = 0, dir = lockDir): Promise<void> {
    const path = join(dir, LOCK_FILE);
    const startedAt = new Date(Date.now() - ageMs);
    await writeFile(path, JSON.stringify({ pid, startedAt: startedAt.toISOString() }));
    await utimes(path, startedAt, startedAt);
  }

  it("lets one holder in at a time and removes the lock file afterwards", async () => {
    const events: string[] = [];
    const hold = (name: string) =>
      withRefreshLock(lockDir, key, async () => {
        events.push(`${name} in`);
        await new Promise((done) => setTimeout(done, 100));
        events.push(`${name} out`);
      });

    await Promise.all([hold("first"), hold("second")]);

    // either caller may win the race for the file
    expect([
      ["first in", "first out", "second in", "second out"],
      ["second in", "second out", "first in", "first out"],
    ]).toContainEqual(events);
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("removes the lock file when fn throws", async () => {
    const failing = withRefreshLock(lockDir, key, async () => {
      throw new Error("refresh refused");
    });

    await expect(failing).rejects.toThrow("refresh refused");
    expect(await readdir(lockDir)).toEqual([]);
  });

  it("takes over a lock whose pid no longer runs", async () => {
    await writeLock(await exitedPid());

    expect(await withRefreshLock(lockDir, key, async () => "refreshed", 1_000)).toBe("refreshed");
  });

  it("lets one process in at a time when several take over the same dead holder's lock", async () => {
    const pid = await exitedPid();
    const trialDirs = await Promise.all(
      Array.from({ length: 6 }, () => mkdtemp(join(lockDir, "trial-"))),
    );
    await Promise.all(trialDirs.map((dir) => writeLock(pid, 0, dir)));
    const lockModule = new URL("../src/auth/lock.ts", import.meta.url).href;
    const startAt = Date.now() + 500;
    const start = () =>
      run(process.execPath, [
        "--input-type=module",
        "-e",
        TAKEOVER_WORKER,
        lockModule,
        String(startAt),
        ...trialDirs,
      ]);

    const workers = await Promise.all(Array.from({ length: 8 }, start));

    expect(workers.map((worker) => worker.stdout)).toEqual(Array(8).fill("0"));
  }, 30_000);

  it("keeps the lock while fn runs longer than two minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const path = join(lockDir, LOCK_FILE);
    const entered = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const holder = withRefreshLock(lockDir, key, async () => {
      entered.resolve();
      await done.promise;
    });
    try {
      await entered.promise;
      const threeMinutesAgo = new Date(Date.now() - 3 * 60_000);
      await utimes(path, threeMinutesAgo, threeMinutesAgo);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () =>
        expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(60_000),
      );
      const waiter = await withRefreshLock(lockDir, key, async () => "taken over", 200).catch(
        (error: unknown) => error,
      );

      expect(waiter).toBeInstanceOf(RefreshLockTimeout);
    } finally {
      vi.useRealTimers();
      done.resolve();
      await holder;
    }
  });

  it("takes over a lock older than two minutes even when its pid still runs", async () => {
    await writeLock(process.pid, 2 * 60_000 + 1_000);

    expect(await withRefreshLock(lockDir, key, async () => "refreshed", 1_000)).toBe("refreshed");
  });

  it("throws RefreshLockTimeout naming the holder pid when the wait runs out", async () => {
    await writeLock(process.pid);

    const failure = await withRefreshLock(lockDir, key, async () => "refreshed", 200).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RefreshLockTimeout);
    expect((failure as RefreshLockTimeout).message).toBe(
      `timed out waiting for the refresh lock held by pid ${process.pid}; wait for that process to finish or stop it`,
    );
  });
});

async function exitedPid(): Promise<number> {
  const exited = execFile(process.execPath, ["-e", ""]);
  await new Promise((done) => exited.on("exit", done));
  return exited.pid ?? 0;
}

// Runs in a separate Node process: at the same moment as the other workers, give or take two milliseconds,
// takes the lock in each trial folder, whose lock a dead process holds, and prints how often it found
// another worker inside.
const TAKEOVER_WORKER = `
const [lockModule, startAt, ...trialDirs] = process.argv.slice(1);
const { withRefreshLock } = await import(lockModule);
const { rm, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { setTimeout: sleep } = await import("node:timers/promises");

const key = { env: "demo", identity: "customer", surface: "api", strategy: "oauth2" };
let overlaps = 0;
for (const [index, dir] of trialDirs.entries()) {
  await sleep(Math.max(0, Number(startAt) + index * 300 - Date.now()) + Math.random() * 2);
  await withRefreshLock(dir, key, async () => {
    try {
      await writeFile(join(dir, "inside"), "", { flag: "wx" });
    } catch {
      overlaps += 1;
      return;
    }
    await sleep(10);
    await rm(join(dir, "inside"));
  }, 10_000);
}
process.stdout.write(String(overlaps));
`;
