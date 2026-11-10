import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DriverSession, StepHandler } from "@bazam/core/driver";
import type { Environment } from "@bazam/core/env";
import { PluginRegistry } from "@bazam/core/plugin";
import { ProjectConfig } from "@bazam/core/project";
import { CaseBlocked, HarnessError } from "@bazam/core/run";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { pageFor } from "../src/index.ts";
import type { WebSession } from "../src/driver.ts";
import {
  demoEnv,
  ENGINES,
  html,
  launch,
  newEvidence,
  startSite,
  stepContext,
  tempDir,
  type Site,
} from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe.each(ENGINES)("pageFor on %s", (engine) => {
  let site: Site;
  let env: Environment;
  let root: string;
  let session: WebSession | undefined;

  beforeAll(async () => {
    site = await startSite({
      "/whoami": (request, response) => response.end(`cookie: ${request.headers.cookie ?? "none"}`),
      "/saved": html('<p data-testid="full-saved"> +447700900456 </p>'),
      "/": html("<p>home</p>"),
    });
    env = demoEnv();
  });
  afterAll(() => site.close());
  afterEach(async () => {
    await session?.close({ status: "pass", evidence: newEvidence(root, "X") }).catch(() => {});
    await rm(root, { recursive: true, force: true });
    session = undefined;
  });

  // reads what the cookie jar of the step's page sends
  const readPage: StepHandler<null> = {
    kind: "read-page",
    schema: z.null(),
    opensBrowser: true,
    async run(_step, ctx) {
      const page = await pageFor(ctx);
      await page.goto(`${site.origin}/whoami`);
      ctx.values.set("seen", (await page.textContent("body")) ?? "");
    },
  };

  it("runs the page-text step of the example plugin in examples/plugins/page-step", async () => {
    const { session, evidence } = await open();
    const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
    const config = ProjectConfig.parse({ envs: {}, plugins: ["./plugins/page-step/manifest.ts"] });
    const registry = await PluginRegistry.load(config, examples, []);
    const handler = registry.stepHandlers().find((step) => step.kind === "page-text");
    const ctx = stepContext(session, { env, evidence, root });
    await (await pageFor(ctx)).goto(`${site.origin}/saved`);

    await handler?.run({ id: "full-saved", save: "saved" }, ctx);

    expect(handler?.opensBrowser).toBe(true);
    expect(ctx.values.get("saved")).toBe("+447700900456");
  });

  async function open() {
    root = await tempDir();
    session = await launch(engine, { env, runDir: root });
    return { session, evidence: newEvidence(root, "WEB-PAGE-001") };
  }

  it("gives a step with opensBrowser the page of an identity whose storage state was applied", async () => {
    const { session, evidence } = await open();
    await (
      await session.browserFor("customer")
    ).loadStorageState({
      cookies: [
        {
          name: "sid",
          value: "fake-customer-session",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
    const ctx = stepContext(session, { env, evidence, root, identity: "customer" });

    await readPage.run(null, ctx);

    expect(ctx.values.get("seen")).toBe("cookie: sid=fake-customer-session");
  });

  it("throws a harness error naming the identity and opensBrowser when its context never opened", async () => {
    const { session, evidence } = await open();
    const ctx = stepContext(session, { env, evidence, root, identity: "customer" });

    const failure = await pageFor(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessError);
    expect((failure as Error).message).toContain('"customer"');
    expect((failure as Error).message).toContain("opensBrowser");
  });

  it("refuses a navigation to a host outside the env's hosts", async () => {
    const { session, evidence } = await open();
    await session.browserFor("customer");
    const ctx = stepContext(session, { env, evidence, root, identity: "customer" });
    const page = await pageFor(ctx);

    await expect(page.goto(`${site.elsewhere}/whoami`)).rejects.toThrow();

    expect(site.requests.filter((request) => request.host.startsWith("localhost"))).toEqual([]);
  });
});

describe("pageFor", () => {
  it("blocks the case when the session is not a WebSession", async () => {
    const root = await tempDir();
    try {
      const other = {} as DriverSession;
      const ctx = stepContext(other, { env: demoEnv(), evidence: newEvidence(root, "X"), root });
      await expect(pageFor(ctx)).rejects.toBeInstanceOf(CaseBlocked);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
