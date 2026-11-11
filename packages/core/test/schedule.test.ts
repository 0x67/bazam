import { setImmediate as settle } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";
import { runUnits, type WorkUnit } from "../src/run/schedule.ts";

function unit(positions: number | number[], ...locks: string[]): WorkUnit {
  return { positions: typeof positions === "number" ? [positions] : positions, locks };
}

/** Runs each unit until the test ends it, noting `start <first position>` in `started`. */
class Units {
  readonly started: number[] = [];
  readonly #ends = new Map<number, PromiseWithResolvers<void>>();

  readonly run = async (unit: WorkUnit): Promise<string[]> => {
    const first = unit.positions[0]!;
    this.started.push(first);
    await this.#end(first).promise;
    return unit.positions.map((position) => `result ${position}`);
  };

  /** Ends the unit whose first position is `first`, with `error` when given, and lets the schedule move on. */
  async end(first: number, error?: Error): Promise<void> {
    if (error === undefined) this.#end(first).resolve();
    else this.#end(first).reject(error);
    await settle();
  }

  #end(first: number): PromiseWithResolvers<void> {
    let end = this.#ends.get(first);
    if (end === undefined) {
      end = Promise.withResolvers<void>();
      this.#ends.set(first, end);
    }
    return end;
  }
}

/** Notes whether `promise` has settled yet, and keeps its rejection handled. */
function watch<T>(promise: Promise<T>): { settled: () => boolean } {
  let settled = false;
  const note = (): void => {
    settled = true;
  };
  promise.then(note, note);
  return { settled: () => settled };
}

describe("runUnits", () => {
  it("starts units in plan order up to the worker count and returns results by plan position", async () => {
    const units = new Units();
    const all = runUnits(
      [unit(0), unit(1), unit(2), unit(3)],
      2,
      units.run,
      new AbortController().signal,
    );
    await settle();
    expect(units.started).toEqual([0, 1]);
    await units.end(1);
    expect(units.started).toEqual([0, 1, 2]);
    await units.end(0);
    await units.end(3);
    await units.end(2);
    expect(await all).toEqual(["result 0", "result 1", "result 2", "result 3"]);
  });

  it("puts the results of a unit with several positions at each of them", async () => {
    const units = new Units();
    const all = runUnits(
      [unit([0, 2], "runner:shop"), unit(1)],
      2,
      units.run,
      new AbortController().signal,
    );
    await units.end(1);
    await units.end(0);
    expect(await all).toEqual(["result 0", "result 1", "result 2"]);
  });

  it("never runs two units that share an identity, and starts a later unit past one that waits", async () => {
    const units = new Units();
    const all = runUnits(
      [unit(0, "customer"), unit(1, "shopper", "customer"), unit(2, "courier")],
      2,
      units.run,
      new AbortController().signal,
    );
    await settle();
    expect(units.started).toEqual([0, 2]);
    await units.end(2);
    expect(units.started).toEqual([0, 2]);
    await units.end(0);
    expect(units.started).toEqual([0, 2, 1]);
    await units.end(1);
    expect(await all).toEqual(["result 0", "result 1", "result 2"]);
  });

  it("never runs two units of one runner at once", async () => {
    const units = new Units();
    const all = runUnits(
      [unit(0, "runner:shop", "customer"), unit(1, "runner:shop", "shopper"), unit(2)],
      3,
      units.run,
      new AbortController().signal,
    );
    await settle();
    expect(units.started).toEqual([0, 2]);
    await units.end(0);
    expect(units.started).toEqual([0, 2, 1]);
    await units.end(1);
    await units.end(2);
    expect(await all).toHaveLength(3);
  });

  it("after a unit rejects, starts no other unit and rejects with the first error once the running ones end", async () => {
    const units = new Units();
    const all = runUnits([unit(0), unit(1), unit(2)], 2, units.run, new AbortController().signal);
    const watched = watch(all);
    await units.end(0, new Error("fake launch 1 failed"));
    expect(watched.settled()).toBe(false);
    await units.end(1, new Error("fake launch 2 failed"));
    await expect(all).rejects.toThrow("fake launch 1 failed");
    expect(units.started).toEqual([0, 1]);
  });

  it("starts no unit once the signal aborts and rejects with its reason after the running ones end", async () => {
    const units = new Units();
    const stop = new AbortController();
    const all = runUnits([unit(0), unit(1)], 1, units.run, stop.signal);
    const watched = watch(all);
    await settle();
    stop.abort(new Error("run cancelled"));
    await settle();
    expect(watched.settled()).toBe(false);
    await units.end(0);
    await expect(all).rejects.toThrow("run cancelled");
    expect(units.started).toEqual([0]);
  });

  it.each([0, 1.5])("refuses %s workers", async (workers) => {
    await expect(
      runUnits([unit(0)], workers, new Units().run, new AbortController().signal),
    ).rejects.toThrow(RangeError);
  });
});
