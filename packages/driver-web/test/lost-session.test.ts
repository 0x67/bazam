import type { IncomingMessage, ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionLost } from "@bazam/core/run";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { WebSession } from "../src/driver.ts";
import {
  demoEnv,
  ENGINES,
  html,
  launch,
  newEvidence,
  runSteps,
  startSite,
  stepContext,
  tempDir,
  type Site,
} from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CASE_ID = "WEB-LOST-001";

function redirectTo(location: string) {
  return (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(303, { location });
    response.end();
  };
}

describe.each(ENGINES)("lost sessions on %s", (engine) => {
  let site: Site;
  let root: string;
  let session: WebSession | undefined;
  const env = demoEnv();

  beforeAll(async () => {
    site = await startSite({
      "/": html("<h1>Home</h1>"),
      "/login": html("<h1>Log in</h1>"),
      "/orders": redirectTo("/login?next=%2Forders"),
      "/login/": redirectTo("/login?next=%2F"),
      "/sso": redirectTo("/login/sso"),
      "/login/sso": redirectTo("/idp"),
      "/idp": html("<h1>Identity provider</h1>"),
      "/double": redirectTo("/login/start"),
      "/login/start": redirectTo("/login/form"),
      "/login/form": html("<h1>Log in</h1>"),
    });
  });

  afterAll(() => site.close());

  beforeEach(async () => {
    root = await tempDir();
  });

  afterEach(async () => {
    await session?.close({ status: "pass", evidence: newEvidence(root, CASE_ID) });
    session = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /** A session whose identity "customer" watches the login page. */
  async function watching(headers: Record<string, string> = {}) {
    session = await launch(engine, { env, runDir: join(root, "runs") });
    const browser = await session.browserFor("customer");
    if (Object.keys(headers).length > 0) await browser.setExtraHeaders(headers);
    const lost: string[] = [];
    browser.onSessionLost?.(`${site.origin}/login*`, (url) => lost.push(url));
    const ctx = stepContext(session, {
      env,
      evidence: newEvidence(join(root, "runs"), CASE_ID),
      root,
      identity: "customer",
    });
    return { lost, ctx };
  }

  it("fires once with the login URL when a redirect leads there, and the open step throws SessionLost", async () => {
    const { lost, ctx } = await watching();

    await expect(runSteps(ctx, [{ open: `${site.origin}/orders` }])).rejects.toBeInstanceOf(
      SessionLost,
    );

    expect(lost).toEqual([`${site.origin}/login?next=%2Forders`]);
  });

  it("sees the hop when extra headers make the route send the request itself", async () => {
    const { lost, ctx } = await watching({ Authorization: "Bearer fake-bearer-7f3a9c" });

    await expect(runSteps(ctx, [{ open: `${site.origin}/orders` }])).rejects.toBeInstanceOf(
      SessionLost,
    );

    expect(lost).toEqual([`${site.origin}/login?next=%2Forders`]);
  });

  it.each([
    ["", {}],
    [" with extra headers", { Authorization: "Bearer fake-bearer-7f3a9c" }],
  ])("fires nothing when the navigation starts at a login URL%s", async (_name, headers) => {
    const { lost, ctx } = await watching(headers);

    await runSteps(ctx, [{ open: `${site.origin}/login/` }]);

    expect(lost).toEqual([]);
  });

  it.each([
    ["", {}],
    [" with extra headers", { Authorization: "Bearer fake-bearer-7f3a9c" }],
  ])("fires once for a chain with several login hops%s", async (_name, headers) => {
    const { lost, ctx } = await watching(headers);

    await expect(runSteps(ctx, [{ open: `${site.origin}/double` }])).rejects.toBeInstanceOf(
      SessionLost,
    );

    expect(lost).toHaveLength(1);
  });

  it("sees a login hop the chain passes through and leaves, with extra headers too", async () => {
    for (const headers of [{}, { Authorization: "Bearer fake-bearer-7f3a9c" }]) {
      const { lost, ctx } = await watching(headers);

      await expect(runSteps(ctx, [{ open: `${site.origin}/sso` }])).rejects.toBeInstanceOf(
        SessionLost,
      );

      expect(lost).toHaveLength(1);
      await session?.close({ status: "pass", evidence: newEvidence(root, CASE_ID) });
      session = undefined;
    }
  });

  it("stops firing once the listener is stopped", async () => {
    session = await launch(engine, { env, runDir: join(root, "runs") });
    const browser = await session.browserFor("customer");
    const lost: string[] = [];
    const stop = browser.onSessionLost!(`${site.origin}/login*`, (url) => lost.push(url));
    stop();
    const ctx = stepContext(session, {
      env,
      evidence: newEvidence(join(root, "runs"), CASE_ID),
      root,
      identity: "customer",
    });

    await runSteps(ctx, [{ open: `${site.origin}/orders` }]);

    expect(lost).toEqual([]);
  });

  it("subscribes nothing in a login tab, so a flow that opens the redirect does not throw", async () => {
    session = await launch(engine, { env, runDir: join(root, "runs") });

    const done = await session.browserLogin.login({
      url: new URL(`${site.origin}/`),
      flow: [{ open: `${site.origin}/orders` }],
      until: { urlMatches: `${site.origin}/login*` },
      timeoutMs: 15_000,
    });

    expect(done.finalUrl.pathname).toBe("/login");
  });
});
