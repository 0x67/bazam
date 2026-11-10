import type { Step } from "../case/index.ts";
import type { PersonPrompt } from "../challenge/index.ts";
import type { JsonValue } from "./strategy.ts";

// Ports for the browser, so core never imports Playwright; driver-web implements them.

// a type alias, not an interface, so a strategy can use it as its JsonValue credential
export type StorageState = {
  cookies: JsonValue[];
  origins: JsonValue[];
};

/** One browser context, the one an identity acts in. */
export interface BrowserSession {
  storageState(): Promise<StorageState>;
  loadStorageState(state: StorageState): Promise<void>;
  setExtraHeaders(headers: Record<string, string>): Promise<void>;
  /** The browser answers HTTP authentication challenges from hosts in the env's allowlist with these credentials; other hosts never get them. */
  setHttpCredentials(credentials: { username: string; password: string }): Promise<void>;
  /**
   * Calls `listener` with the origin of each 401 response to a fetch or XHR request that the context gets from
   * a host in the env's allowlist; returns a function that stops it.
   */
  onUnauthorized?(listener: (origin: string) => void): () => void;
  /**
   * Calls `listener` with the URL when a redirect brings a main-frame navigation to a URL that matches `pattern`,
   * from one that does not; returns a function that stops it.
   */
  onSessionLost?(pattern: string, listener: (url: string) => void): () => void;
}

/** The login is done when this cookie is set, or when the page URL matches this pattern. */
export type LoginDone = { cookie: string } | { urlMatches: string };

export interface BrowserLoginRequest {
  url: URL;
  /** Scripted steps that run once `url` is open; with a `prompt`, they run before the person acts. */
  flow?: Step[];
  until: LoginDone;
  /** What the person is asked to do once the flow has run. */
  prompt?: PersonPrompt;
  timeoutMs: number;
  /** Ends the login early, as when the person answers blocked or the prompt times out. */
  signal?: AbortSignal;
}

export interface BrowserLogin {
  login(request: BrowserLoginRequest): Promise<{ state: StorageState; finalUrl: URL }>;
}
