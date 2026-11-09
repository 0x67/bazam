import { z } from "zod";
import type { StorageState } from "../../src/auth/index.ts";
import type {
  Capability,
  CaseEnding,
  Driver,
  DriverSession,
  LaunchOptions,
  StepHandler,
} from "../../src/driver/index.ts";
import { FakeBrowserLogin, FakeBrowserSession } from "./fake-browser.ts";

export interface FakeDriverOptions {
  name?: string;
  surface?: string;
  capabilities?: readonly Capability[];
  steps?: readonly StepHandler[];
  /** Cookies every browser login ends with, on a driver with browser.login. */
  loginCookies?: StorageState["cookies"];
  /** How long each browser login takes; see FakeLoginOptions. */
  loginDelayMs?: number;
  /** What each browser login also waits for; see FakeLoginOptions. */
  loginWaitsFor?: Promise<unknown>;
  /** Launches that throw, counted from 1, as when the browser cannot start. */
  failingLaunches?: readonly number[];
  /** What every session's close throws after it records the ending, as a driver that reports a late problem does. */
  closeError?: Error;
}

/** One launch of a fake driver and what the run did with it. */
export interface FakeSession extends DriverSession {
  options: LaunchOptions;
  /** The browser context of each identity, made on first use. */
  browsers: Map<string, FakeBrowserSession>;
  browserLogin?: FakeBrowserLogin;
  /** Undefined until the session is closed. */
  closedWith: CaseEnding | undefined;
}

export interface FakeDriver extends Driver {
  /** Every session launched so far, in order; a failed launch adds none. */
  sessions: FakeSession[];
}

/**
 * A driver with no device behind it: probe and every session report the configured capabilities.
 * With browser.login, each session also has fake browser contexts and a fake login.
 * Closing with a status other than pass attaches `trace.zip`.
 */
export function fakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  const capabilities: ReadonlySet<Capability> = new Set(options.capabilities ?? []);
  const sessions: FakeSession[] = [];
  let launches = 0;
  return {
    name: options.name ?? "fake",
    surface: options.surface ?? "web",
    probe: async () => capabilities,
    launch: async (launchOptions) => {
      launches += 1;
      if (options.failingLaunches?.includes(launches) === true) throw new Error(`fake launch ${launches} failed`);
      const login = new FakeBrowserLogin(options.loginCookies ?? [], {
        ...(options.loginDelayMs === undefined ? {} : { delayMs: options.loginDelayMs }),
        ...(options.loginWaitsFor === undefined ? {} : { waitsFor: options.loginWaitsFor }),
      });
      const session = fakeSession(launchOptions, capabilities, login, options.closeError);
      sessions.push(session);
      return session;
    },
    steps: options.steps ?? [],
    sessions,
  };
}

function fakeSession(
  options: LaunchOptions,
  capabilities: ReadonlySet<Capability>,
  login: FakeBrowserLogin,
  closeError: Error | undefined,
): FakeSession {
  const session: FakeSession = {
    options,
    capabilities,
    browsers: new Map(),
    closedWith: undefined,
    close: async (ending) => {
      session.closedWith = ending;
      if (ending.status !== "pass")
        await ending.evidence.attach("trace", new TextEncoder().encode("fake trace bytes"), "zip");
      if (closeError !== undefined) throw closeError;
    },
  };
  if (capabilities.has("browser.login")) {
    session.browserLogin = login;
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
