import type { BrowserLogin, BrowserLoginRequest, BrowserSession, StorageState } from "../../src/auth/index.ts";

/** One browser context held in memory: its storage state and the extra headers set on it. */
export class FakeBrowserSession implements BrowserSession {
  state: StorageState = { cookies: [], origins: [] };
  extraHeaders: Record<string, string> = {};

  async storageState(): Promise<StorageState> {
    return structuredClone(this.state);
  }

  async loadStorageState(state: StorageState): Promise<void> {
    this.state = structuredClone(state);
  }

  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = { ...this.extraHeaders, ...headers };
  }
}

/** Finishes every login at once with the given cookies, as if the flow and the person had both succeeded. */
export class FakeBrowserLogin implements BrowserLogin {
  readonly requests: BrowserLoginRequest[] = [];
  readonly #cookies: StorageState["cookies"];

  constructor(cookies: StorageState["cookies"]) {
    this.#cookies = cookies;
  }

  async login(request: BrowserLoginRequest): Promise<{ state: StorageState; finalUrl: URL }> {
    this.requests.push(request);
    return { state: { cookies: structuredClone(this.#cookies), origins: [] }, finalUrl: request.url };
  }
}
