import { setTimeout as sleep } from "node:timers/promises";
import type { Identities } from "../auth/index.ts";
import { messageOf } from "./outcome.ts";
import { loginKey } from "./plan.ts";

export interface RefreshedCredential {
  identity: string;
  surface: string;
}

export interface IntervalRefreshDeps {
  identities: Pick<Identities, "recoverFromUnauthorized">;
  /** Called after a refresh that worked, so the running case can load the credential. */
  refreshed(credential: RefreshedCredential): void;
  /** Called with the note a failed refresh leaves on the identity's running case. */
  failed(credential: RefreshedCredential, note: string): void;
  log(line: string): void;
  /** Waits `ms`, and rejects when `signal` aborts; node's timers by default. */
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}

interface Entry extends RefreshedCredential {
  everyMs: number;
  /** The cases left that use the credential. */
  cases: number;
  stop: AbortController;
}

/** Refreshes each credential on its own interval while cases that act as its identity remain. */
export class IntervalRefresh {
  readonly #deps: IntervalRefreshDeps;
  readonly #entries: Entry[];
  readonly #loops: Promise<void>[] = [];

  constructor(deps: IntervalRefreshDeps, plan: readonly (RefreshedCredential & { everyMs: number; cases: number })[]) {
    this.#deps = deps;
    this.#entries = plan.map((entry) => ({ ...entry, stop: new AbortController() }));
  }

  start(): void {
    for (const entry of this.#entries) this.#loops.push(this.#loop(entry));
  }

  /** Counts the case down for each credential it used, by loginKey; a credential's timer stops after its last case. */
  caseEnded(keys: readonly string[]): void {
    for (const entry of this.#entries) {
      if (!keys.includes(loginKey(entry)) || entry.stop.signal.aborted) continue;
      entry.cases -= 1;
      if (entry.cases <= 0) entry.stop.abort();
    }
  }

  /** Stops every timer and waits for the refresh in flight. */
  async stop(): Promise<void> {
    for (const entry of this.#entries) entry.stop.abort();
    await Promise.all(this.#loops);
  }

  // the wait starts after the last refresh ends, so refreshes never overlap
  async #loop(entry: Entry): Promise<void> {
    const wait = this.#deps.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    const { signal } = entry.stop;
    while (!signal.aborted) {
      try {
        await wait(entry.everyMs, signal);
      } catch {
        return;
      }
      await this.#tick(entry);
    }
  }

  /** Never throws. */
  async #tick(entry: Entry): Promise<void> {
    const { identity, surface } = entry;
    let reason: string;
    try {
      if (await this.#deps.identities.recoverFromUnauthorized(identity, surface)) {
        this.#deps.refreshed({ identity, surface });
        return;
      }
      reason = "the strategy has nothing to refresh";
    } catch (error) {
      reason = messageOf(error);
    }
    const note = `refreshing ${identity}'s ${surface} credential on its interval failed: ${reason}`;
    this.#deps.log(note);
    this.#deps.failed({ identity, surface }, note);
  }
}
