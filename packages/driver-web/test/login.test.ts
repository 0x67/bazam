import { rm } from "node:fs/promises";
import type { BrowserLogin } from "@bazam/core/auth";
import { HostNotAllowed, type Environment } from "@bazam/core/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { WebSession } from "../src/driver.ts";
import { urlMatches } from "../src/login.ts";
import { demoEnv, ENGINES, html, launch, newEvidence, startSite, tempDir, type Site } from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const LOGIN_FORM = `
<form method="post" action="/session">
  <label>Email <input name="email" data-testid="email"></label>
  <button>Sign in</button>
</form>
<a href="{elsewhere}/sso">Sign in elsewhere</a>
`;

describe("urlMatches", () => {
  it("lets * span slashes and query strings and matches every other character as itself", () => {
    expect(
      urlMatches(
        "https://app.example.test/callback*",
        "https://app.example.test/callback/done?code=fake-code&state=s1",
      ),
    ).toBe(true);
    expect(urlMatches("https://app.example.test/callback*", "https://app.example.test/login?next=/callback")).toBe(
      false,
    );
    expect(urlMatches("https://app.example.test/a.b*", "https://app.example.test/axb")).toBe(false);
    expect(urlMatches("https://*.example.test/home", "https://uat.example.test/home")).toBe(true);
  });
});

describe.each(ENGINES)("viewport on %s", (engine) => {
  it("opens the login tab at the target's viewport", async () => {
    const sizes: string[] = [];
    const site = await startSite({
      // the cookie is set once the size is reported, so the login ends after the server has it
      "/login": html(
        `<script>fetch("/size?" + innerWidth + "x" + innerHeight).then(() => { document.cookie = "sid=fake-1"; });</script>`,
      ),
      "/size": (request, response) => {
        sizes.push(request.url!.split("?")[1]!);
        response.end();
      },
    });
    const root = await tempDir();
    const session = await launch(engine, {
      env: demoEnv(),
      runDir: root,
      settings: { viewport: { width: 700, height: 500 } },
    });
    try {
      await session.browserLogin.login({
        url: new URL(`${site.origin}/login`),
        until: { cookie: "sid" },
        timeoutMs: 10_000,
      });
    } finally {
      await session.close({ status: "pass", evidence: newEvidence(root, "WEB-LOGIN-002") });
      await site.close();
      await rm(root, { recursive: true, force: true });
    }

    expect(sizes).toEqual(["700x500"]);
  });
});

describe.each(ENGINES)("browser login on %s", (engine) => {
  let site: Site;
  let env: Environment;
  let root: string;
  let session: WebSession;
  let login: BrowserLogin;

  beforeAll(async () => {
    site = await startSite({
      "/login": html(LOGIN_FORM),
      "/session": (_request, response) => {
        response.writeHead(303, {
          "set-cookie": "sid=fake-session-5d2e8b; Path=/; HttpOnly",
          location: "/callback/done?code=fake-code",
        });
        response.end();
      },
      "/callback/done": html("<h1>Signed in</h1>"),
    });
    env = demoEnv();
    root = await tempDir();
    session = await launch(engine, { env, runDir: root });
    login = session.browserLogin;
  });

  afterAll(async () => {
    await session.close({ status: "pass", evidence: newEvidence(root, "WEB-LOGIN-001") });
    await site.close();
    await rm(root, { recursive: true, force: true });
  });

  const flow = [
    { fill: { field: { id: "email" }, value: "ops@example.test" } },
    { tap: { role: "button", name: "Sign in" } },
  ];

  it("runs the flow and returns the storage state once the cookie is set", async () => {
    const { state } = await login.login({
      url: new URL(`${site.origin}/login`),
      flow,
      until: { cookie: "sid" },
      timeoutMs: 10_000,
    });

    expect(state.cookies).toContainEqual(expect.objectContaining({ name: "sid", value: "fake-session-5d2e8b" }));
  });

  it("returns the final URL once it matches the urlMatches glob", async () => {
    const { finalUrl } = await login.login({
      url: new URL(`${site.origin}/login`),
      flow,
      until: { urlMatches: `${site.origin}/callback*` },
      timeoutMs: 10_000,
    });

    expect(finalUrl.href).toBe(`${site.origin}/callback/done?code=fake-code`);
  });

  it("gives up after timeoutMs when until is never reached", async () => {
    const attempt = login.login({ url: new URL(`${site.origin}/login`), until: { cookie: "sid" }, timeoutMs: 1_000 });

    await expect(attempt).rejects.toThrow(`the login at ${site.origin}/login did not reach cookie sid within 1000 ms`);
  });

  it("stops as soon as the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("the person answered blocked")), 500);
    const started = Date.now();

    const attempt = login.login({
      url: new URL(`${site.origin}/login`),
      until: { cookie: "sid" },
      timeoutMs: 20_000,
      signal: controller.signal,
    });

    await expect(attempt).rejects.toThrow("the person answered blocked");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a login flow that leaves the allowlist", async () => {
    const attempt = login.login({
      url: new URL(`${site.origin}/login`),
      flow: [{ tap: { text: "Sign in elsewhere" } }, { wait: { ms: 300 } }],
      until: { cookie: "sid" },
      timeoutMs: 10_000,
    });

    await expect(attempt).rejects.toThrow(new HostNotAllowed("localhost", env.name));
  });
});
