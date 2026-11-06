import { z } from "zod";
import type { StorageState } from "../../src/auth/index.ts";
import type { Capability, Driver, DriverSession, LaunchOptions, StepHandler } from "../../src/driver/index.ts";
import type { CaseOutcome } from "../../src/result/index.ts";
import { FakeBrowserLogin, FakeBrowserSession } from "./fake-browser.ts";

export interface FakeDriverOptions {
  target?: string;
  capabilities?: readonly Capability[];
  steps?: readonly StepHandler[];
  /** Cookies every browser login ends with, on a driver with browser.login. */
  loginCookies?: StorageState["cookies"];
}

/** One launch of a fake driver and what the run did with it. */
export interface FakeSession extends DriverSession {
  options: LaunchOptions;
  /** The browser context of each identity, made on first use. */
  browsers: Map<string, FakeBrowserSession>;
  /** Undefined until the session is closed. */
  closedWith: CaseOutcome | undefined;
}

export interface FakeDriver extends Driver {
  /** Every session launched so far, in order. */
  sessions: FakeSession[];
}

/**
 * A driver with no device behind it: probe and every session report the configured capabilities.
 * With browser.login, each session also has fake browser contexts and a fake login.
 */
export function fakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  const capabilities: ReadonlySet<Capability> = new Set(options.capabilities ?? []);
  const sessions: FakeSession[] = [];
  return {
    target: options.target ?? "fake",
    probe: async () => capabilities,
    launch: async (launchOptions) => {
      const session = fakeSession(launchOptions, capabilities, options.loginCookies ?? []);
      sessions.push(session);
      return session;
    },
    steps: options.steps ?? [],
    sessions,
  };
}

function fakeSession(options: LaunchOptions, capabilities: ReadonlySet<Capability>, loginCookies: StorageState["cookies"]): FakeSession {
  const session: FakeSession = {
    options,
    capabilities,
    browsers: new Map(),
    closedWith: undefined,
    close: async (outcome) => {
      session.closedWith = outcome;
    },
  };
  if (capabilities.has("browser.login")) {
    session.browserLogin = new FakeBrowserLogin(loginCookies);
    session.browserFor = async (identity) => {
      const browser = session.browsers.get(identity) ?? new FakeBrowserSession();
      session.browsers.set(identity, browser);
      return browser;
    };
  }
  return session;
}

/** A step handler that accepts any payload and does nothing. */
export function fakeStep(kind: string): StepHandler {
  return { kind, schema: z.unknown(), run: async () => {} };
}
