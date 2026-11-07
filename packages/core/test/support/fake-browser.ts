import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserLogin, BrowserLoginRequest, BrowserSession, StorageState } from "../../src/auth/index.ts";

/** One browser context held in memory: its storage state and the extra headers and HTTP credentials set on it. */
export class FakeBrowserSession implements BrowserSession {
  state: StorageState = { cookies: [], origins: [] };
  extraHeaders: Record<string, string> = {};
  httpCredentials: { username: string; password: string } | undefined;

  async storageState(): Promise<StorageState> {
    return structuredClone(this.state);
  }

  async loadStorageState(state: StorageState): Promise<void> {
    this.state = structuredClone(state);
  }

  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = { ...this.extraHeaders, ...headers };
  }

  async setHttpCredentials(credentials: { username: string; password: string }): Promise<void> {
    this.httpCredentials = { ...credentials };
  }
}

export interface FakeLoginOptions {
  /** How long each login waits for its `until`, as a person would take; the login's signal ends the wait early. */
  delayMs?: number;
}

/**
 * Finishes every login with the given cookies, as if the flow and the person had both succeeded: at once, or
 * after `delayMs` unless the request's signal aborts first.
 */
export class FakeBrowserLogin implements BrowserLogin {
  readonly requests: BrowserLoginRequest[] = [];
  readonly #cookies: StorageState["cookies"];
  readonly #delayMs: number | undefined;

  constructor(cookies: StorageState["cookies"], options: FakeLoginOptions = {}) {
    this.#cookies = cookies;
    this.#delayMs = options.delayMs;
  }

  async login(request: BrowserLoginRequest): Promise<{ state: StorageState; finalUrl: URL }> {
    this.requests.push(request);
    if (this.#delayMs !== undefined) await sleep(this.#delayMs, undefined, request.signal === undefined ? {} : { signal: request.signal });
    return { state: { cookies: structuredClone(this.#cookies), origins: [] }, finalUrl: request.url };
  }
}
