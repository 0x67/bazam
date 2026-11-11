import { setImmediate as flush } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";
import { RefreshLockTimeout } from "../src/auth/index.ts";
import { IntervalRefresh, type RefreshedCredential } from "../src/run/interval-refresh.ts";

interface Wait {
  ms: number;
  aborted: boolean;
  /** Ends the wait, as `ms` passing would. */
  fire(): void;
}

/** An IntervalRefresh whose waits the test ends, over a `recoverFromUnauthorized` the test answers. */
function setup(plan: { everyMs: number; cases: number; identity?: string; surface?: string }[]) {
  const waits: Wait[] = [];
  const refreshed: RefreshedCredential[] = [];
  const notes: string[] = [];
  const logged: string[] = [];
  const recover = {
    calls: [] as string[],
    answer: async (_identity: string, _surface: string): Promise<boolean> => true,
  };
  const refresh = new IntervalRefresh(
    {
      identities: {
        recoverFromUnauthorized: (identity, surface) => {
          recover.calls.push(`${identity}/${surface}`);
          return recover.answer(identity, surface);
        },
      },
      refreshed: (credential) => refreshed.push(credential),
      failed: (_credential, note) => notes.push(note),
      log: (line) => logged.push(line),
      wait: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const wait: Wait = { ms, aborted: false, fire: resolve };
          waits.push(wait);
          signal.addEventListener(
            "abort",
            () => {
              wait.aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
    plan.map(({ identity = "customer", surface = "web", ...rest }) => ({
      identity,
      surface,
      ...rest,
    })),
  );
  const pending = () => waits.filter((wait) => !wait.aborted);
  return { refresh, waits, pending, refreshed, notes, logged, recover };
}

describe("IntervalRefresh", () => {
  it("refreshes after each interval and reports the credential", async () => {
    const { refresh, pending, refreshed, recover } = setup([{ everyMs: 30_000, cases: 1 }]);
    refresh.start();

    expect(pending().map((wait) => wait.ms)).toEqual([30_000]);
    expect(recover.calls).toEqual([]);

    pending()[0]!.fire();
    await flush();
    expect(recover.calls).toEqual(["customer/web"]);
    expect(refreshed).toEqual([{ identity: "customer", surface: "web" }]);

    pending().at(-1)!.fire();
    await flush();
    expect(recover.calls).toHaveLength(2);
    await refresh.stop();
  });

  it("starts the next wait only after the refresh ends, so refreshes never overlap", async () => {
    const { refresh, waits, recover } = setup([{ everyMs: 30_000, cases: 1 }]);
    const slow = Promise.withResolvers<boolean>();
    recover.answer = () => slow.promise;
    refresh.start();

    waits[0]!.fire();
    await flush();
    expect(waits).toHaveLength(1);

    slow.resolve(true);
    await flush();
    expect(waits).toHaveLength(2);
    await refresh.stop();
  });

  it("stops a credential's timer after the last case that acts as its identity", async () => {
    const { refresh, waits, recover } = setup([
      { everyMs: 30_000, cases: 2 },
      { everyMs: 60_000, cases: 1, identity: "partner" },
    ]);
    refresh.start();

    refresh.caseEnded(["customer/web"]);
    expect(waits.map((wait) => wait.aborted)).toEqual([false, false]);

    refresh.caseEnded(["customer/web", "other/web"]);
    expect(waits.map((wait) => wait.aborted)).toEqual([true, false]);

    waits[1]!.fire();
    await flush();
    expect(recover.calls).toEqual(["partner/web"]);
    await refresh.stop();
  });

  it("counts down only the surface a case used when an identity refreshes two", async () => {
    const { refresh, waits } = setup([
      { everyMs: 30_000, cases: 1, surface: "web" },
      { everyMs: 30_000, cases: 1, surface: "mobile" },
    ]);
    refresh.start();

    refresh.caseEnded(["customer/web"]);

    expect(waits.map((wait) => wait.aborted)).toEqual([true, false]);
    await refresh.stop();
  });

  it("notes a refresh that throws or refreshes nothing and goes on", async () => {
    const { refresh, pending, notes, logged, refreshed, recover } = setup([
      { everyMs: 30_000, cases: 1 },
    ]);
    const answers = [
      () => Promise.reject(new RefreshLockTimeout(4242)),
      () => Promise.resolve(false),
      () => Promise.resolve(true),
    ];
    recover.answer = () => answers.shift()!();
    refresh.start();

    for (let tick = 0; tick < 3; tick++) {
      pending().at(-1)!.fire();
      await flush();
    }

    expect(notes).toEqual([
      "refreshing customer's web credential on its interval failed: timed out waiting for the refresh lock held by pid 4242; wait for that process to finish or stop it",
      "refreshing customer's web credential on its interval failed: the strategy has nothing to refresh",
    ]);
    expect(logged).toEqual(notes);
    expect(refreshed).toHaveLength(1);
    await refresh.stop();
  });

  it("waits for the refresh in flight when it stops", async () => {
    const { refresh, waits, recover } = setup([{ everyMs: 30_000, cases: 1 }]);
    const slow = Promise.withResolvers<boolean>();
    recover.answer = () => slow.promise;
    refresh.start();
    waits[0]!.fire();
    await flush();

    let stopped = false;
    const stopping = refresh.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);

    slow.resolve(true);
    await stopping;
    expect(waits).toHaveLength(1);
  });
});
