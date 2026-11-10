/** Work that fills some positions of the plan, holding its locks while it runs. */
export interface WorkUnit {
  /** The plan positions the unit's results fill, in the order `run` returns them. */
  positions: readonly number[];
  /**
   * Identity names. An external suite adds `runner:<name>`, and `results:<a>+<b>` for each other runner whose result
   * glob can reach the same files.
   */
  locks: readonly string[];
}

/**
 * Runs up to `workers` units at once and returns their results by plan position. A free worker takes the first
 * waiting unit whose locks no running unit holds, so a unit may start before an earlier one that waits for a lock.
 * After the first unit rejects, or once `signal` aborts, starts no more units, waits for the running ones, then
 * rejects with that first error, or with the signal's reason when no unit rejected.
 */
export async function runUnits<T>(
  units: readonly WorkUnit[],
  workers: number,
  run: (unit: WorkUnit) => Promise<T[]>,
  signal: AbortSignal,
): Promise<T[]> {
  if (!Number.isInteger(workers) || workers < 1)
    throw new RangeError(`workers must be a whole number of 1 or more, not ${workers}`);
  const done = Promise.withResolvers<T[]>();
  const results: T[] = [];
  const waiting = [...units];
  const held = new Set<string>();
  let running = 0;
  let failure: { error: unknown } | undefined;

  const start = async (unit: WorkUnit): Promise<void> => {
    running += 1;
    for (const lock of unit.locks) held.add(lock);
    try {
      const out = await run(unit);
      for (const [index, position] of unit.positions.entries()) results[position] = out[index] as T;
    } catch (error) {
      failure ??= { error };
    } finally {
      running -= 1;
      for (const lock of unit.locks) held.delete(lock);
      fill();
    }
  };

  const fill = (): void => {
    while (failure === undefined && !signal.aborted && running < workers) {
      const next = waiting.findIndex((unit) => unit.locks.every((lock) => !held.has(lock)));
      if (next === -1) break;
      void start(waiting.splice(next, 1)[0]!);
    }
    if (running > 0) return;
    if (failure !== undefined) done.reject(failure.error);
    else if (signal.aborted) done.reject(signal.reason);
    else done.resolve(results);
  };

  fill();
  return done.promise;
}
