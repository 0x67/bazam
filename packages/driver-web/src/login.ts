import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserLogin, BrowserLoginRequest, LoginDone, StorageState } from "@bazam/core/auth";
import type { Step } from "@bazam/core/case";
import type { BrowserContext, Page } from "playwright";

const POLL_MS = 250;

/** The fresh browser context one login runs in, with nothing stored in it yet. */
export interface LoginTab {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Runs one of the driver's web steps on the page. */
  runStep(step: Step): Promise<void>;
  /** Throws the navigation the host guard refused, if there was one. */
  assertAllowed(): void;
  close(): Promise<void>;
}

/**
 * Opens `url`, runs the flow it is given, already expanded and resolved, then waits for `until`.
 * Whoever shows the person's prompt does so around this call; the login itself never asks anyone.
 */
export class PlaywrightLogin implements BrowserLogin {
  readonly #open: (request: BrowserLoginRequest) => Promise<LoginTab>;

  constructor(open: (request: BrowserLoginRequest) => Promise<LoginTab>) {
    this.#open = open;
  }

  async login(request: BrowserLoginRequest): Promise<{ state: StorageState; finalUrl: URL }> {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    const tab = await this.#open(request);
    try {
      return await abortable(drive(tab, request, signal), signal);
    } catch (error) {
      if (timeout.aborted && request.signal?.aborted !== true) {
        throw new Error(
          `the login at ${request.url.origin}${request.url.pathname} did not reach ${describeDone(request.until)} within ${request.timeoutMs} ms; check that the login can get there, or raise timeoutMs in the identity's auth settings (login.timeoutMs for session-cookie)`,
        );
      }
      throw error;
    } finally {
      // closing also ends any step still waiting on the page
      await tab.close();
    }
  }
}

async function drive(
  tab: LoginTab,
  request: BrowserLoginRequest,
  signal: AbortSignal,
): Promise<{ state: StorageState; finalUrl: URL }> {
  await tab.runStep({ open: request.url.href });
  for (const step of request.flow ?? []) {
    signal.throwIfAborted();
    await tab.runStep(step);
  }
  while (!(await isDone(tab, request.until))) {
    tab.assertAllowed();
    try {
      await sleep(POLL_MS, undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
  tab.assertAllowed();
  return { state: await storageStateOf(tab.context), finalUrl: new URL(tab.page.url()) };
}

async function isDone(tab: LoginTab, until: LoginDone): Promise<boolean> {
  if ("cookie" in until)
    return (await tab.context.cookies()).some((cookie) => cookie.name === until.cookie);
  return urlMatches(until.urlMatches, tab.page.url());
}

/** `*` matches any run of characters, `/` included; every other character matches itself. */
export function urlMatches(glob: string, url: string): boolean {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "s").test(url);
}

export async function storageStateOf(context: BrowserContext): Promise<StorageState> {
  const { cookies, origins } = await context.storageState();
  return { cookies, origins };
}

function describeDone(until: LoginDone): string {
  return "cookie" in until ? `cookie ${until.cookie}` : `a URL matching ${until.urlMatches}`;
}

/** Settles with `work`, or rejects with the signal's reason as soon as it aborts. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
