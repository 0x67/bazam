import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { StorageState } from "../../src/auth/index.ts";
import { sessionCookieStrategy } from "../../src/auth/strategies/index.ts";
import { FakeBrowserLogin, FakeBrowserSession } from "../support/fake-browser.ts";
import { authContext, draft, redacted, serve, type LocalServer } from "./support.ts";

function cookie(name: string, value: string, fields: object = {}) {
  return {
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    ...fields,
  };
}

const LOGGED_IN: StorageState = {
  cookies: [cookie("session", "fake-session-1"), cookie("tracker", "fake-tracker-1")],
  origins: [],
};
const STALE: StorageState = { cookies: [cookie("session", "fake-session-0")], origins: [] };

describe("sessionCookieStrategy", () => {
  let server: LocalServer;
  let settings: { login: Record<string, unknown>; probe: object; refresh: object };
  const config = () => sessionCookieStrategy.config.parse(settings);

  beforeAll(async () => {
    server = await serve((request, response) => {
      const cookies = request.headers.cookie ?? "";
      switch (`${request.method} ${request.url.pathname}`) {
        case "GET /api/session/me":
          return response.writeHead(/\bsession=fake-session-[12]\b/.test(cookies) ? 200 : 401).end();
        case "GET /api/session/page":
          if (/\bsession=fake-session-[12]\b/.test(cookies)) return response.writeHead(200).end();
          return response.writeHead(302, { location: "/login" }).end();
        case "GET /login":
        case "GET /home":
          return response.writeHead(200).end();
        case "POST /auth/rotate":
          return response
            .writeHead(303, { location: "/home", "set-cookie": "session=fake-session-2; Path=/; HttpOnly" })
            .end();
        case "POST /auth/refresh":
          if (!cookies.includes("session=fake-session-1")) return response.writeHead(401).end();
          return response
            .writeHead(200, {
              "set-cookie": [
                "session=fake-session-2; Path=/; HttpOnly; SameSite=Strict",
                "tracker=; Max-Age=0; Path=/",
                "csrf=fake-csrf-1",
                "foreign=fake-foreign-1; Domain=other.example.test",
              ],
            })
            .end();
        default:
          return response.writeHead(404).end();
      }
    });
    settings = {
      login: {
        url: `${server.origin}/login`,
        flow: "enter-email",
        until: { cookie: "session" },
        person: { steps: ["Enter the code from your email"], expected: "Dashboard" },
      },
      probe: { request: `GET ${server.origin}/api/session/me`, status: 200 },
      refresh: { request: `POST ${server.origin}/auth/refresh` },
    };
  });

  afterAll(() => server.close());

  it("logs in with the scripted flow, then the person, until the session cookie appears", async () => {
    const login = new FakeBrowserLogin(LOGGED_IN.cookies);

    const state = await sessionCookieStrategy.acquire(config(), authContext({ browser: login }));

    expect(state.cookies).toEqual(LOGGED_IN.cookies);
    const [request] = login.requests;
    expect(request?.url.href).toBe(`${server.origin}/login`);
    expect(request).toMatchObject({
      flow: [{ use: "enter-email" }],
      until: { cookie: "session" },
      prompt: {
        id: "customer-session-cookie-login",
        ask: "action",
        steps: ["Enter the code from your email"],
        expected: "Dashboard",
        timeoutMs: 300_000,
      },
      timeoutMs: 300_000,
    });
  });

  it("a scripted login without a person sends no prompt and waits a minute", async () => {
    const login = new FakeBrowserLogin(LOGGED_IN.cookies);
    const scripted = { login: { url: `${server.origin}/login`, flow: "enter-email", until: { cookie: "session" } } };

    await sessionCookieStrategy.acquire(sessionCookieStrategy.config.parse(scripted), authContext({ browser: login }));

    expect(login.requests[0]?.prompt).toBeUndefined();
    expect(login.requests[0]?.timeoutMs).toBe(60_000);
  });

  it("needs a person only when the login names one, reading unresolved settings", () => {
    expect(
      sessionCookieStrategy.needsPerson?.({
        login: { url: "${env.APP_URL}/login", person: { steps: ["Enter the code"] } },
      }),
    ).toBe(true);
    expect(sessionCookieStrategy.needsPerson?.({ login: { url: "${env.APP_URL}/login", flow: "enter-email" } })).toBe(
      false,
    );
  });

  it("sends only the cookies whose domain, path, Secure flag and expiry match the request", async () => {
    const at = { domain: "api.app.example.test" };
    const state: StorageState = {
      cookies: [
        cookie("parent", "fake-parent", { domain: ".example.test" }),
        cookie("host", "fake-host", { domain: "app.example.test" }),
        cookie("admin", "fake-admin", { ...at, path: "/admin" }),
        cookie("prefix", "fake-prefix", { ...at, path: "/adm" }),
        cookie("secure", "fake-secure", { ...at, secure: true }),
        cookie("expired", "fake-expired", { ...at, expires: 1 }),
      ],
      origins: [],
    };
    const https = draft("GET", "https://api.app.example.test/admin/users");
    const http = draft("GET", "http://api.app.example.test/admin/users");

    await sessionCookieStrategy.apply(state, { kind: "http", request: https }, config());
    await sessionCookieStrategy.apply(state, { kind: "http", request: http }, config());

    expect(https.headers.get("cookie")).toBe("parent=fake-parent; admin=fake-admin; secure=fake-secure");
    expect(http.headers.get("cookie")).toBe("parent=fake-parent; admin=fake-admin");
  });

  it("the probe passes with a live session and fails with a stale one", async () => {
    const ctx = authContext();

    expect(await sessionCookieStrategy.probe?.(LOGGED_IN, config(), ctx)).toBe(true);
    expect(await sessionCookieStrategy.probe?.(STALE, config(), ctx)).toBe(false);
  });

  it("refresh stores what Set-Cookie answers and drops expired and foreign-domain cookies", async () => {
    const ctx = authContext({ now: () => new Date("2026-11-07T09:00:00.000Z") });

    const refreshed = await sessionCookieStrategy.refresh?.(LOGGED_IN, config(), ctx);

    expect(server.received.at(-1)?.headers.cookie).toBe("session=fake-session-1; tracker=fake-tracker-1");
    expect(refreshed?.cookies).toEqual([
      cookie("session", "fake-session-2", { sameSite: "Strict" }),
      cookie("csrf", "fake-csrf-1", { path: "/auth", httpOnly: false }),
    ]);
    expect(await sessionCookieStrategy.probe?.(refreshed ?? STALE, config(), ctx)).toBe(true);
  });

  it("the probe fails when the server redirects a dead session to a login page that answers 200", async () => {
    const page = sessionCookieStrategy.config.parse({
      ...settings,
      probe: { request: `GET ${server.origin}/api/session/page`, status: 200 },
    });

    expect(await sessionCookieStrategy.probe?.(STALE, page, authContext())).toBe(false);
    expect(server.received.at(-1)?.url.pathname).toBe("/api/session/page");
  });

  it("refresh keeps the cookie that a redirecting refresh response sets", async () => {
    const rotate = sessionCookieStrategy.config.parse({
      ...settings,
      refresh: { request: `POST ${server.origin}/auth/rotate`, status: 303 },
    });

    const refreshed = await sessionCookieStrategy.refresh?.(LOGGED_IN, rotate, authContext());

    expect(refreshed?.cookies).toEqual([cookie("tracker", "fake-tracker-1"), cookie("session", "fake-session-2")]);
    expect(server.received.at(-1)?.url.pathname).toBe("/auth/rotate");
  });

  it.each([
    ["part of an IP address", "http://127.0.0.1/auth/refresh", "Domain=0.0.1", "http://10.0.0.1/me"],
    ["a public suffix", "https://api.example.test/auth/refresh", "Domain=test", "https://partner.other.test/me"],
  ])("refresh ignores a cookie whose Domain names %s", async (_, refreshUrl, domain, elsewhere) => {
    const headers = new Headers({ "set-cookie": `wide=fake-wide-cookie; ${domain}` });
    const ctx = authContext({ http: { send: async () => ({ status: 200, headers, body: undefined }) } });
    const wide = sessionCookieStrategy.config.parse({ ...settings, refresh: { request: `POST ${refreshUrl}` } });
    const request = draft("GET", elsewhere);

    const refreshed = await sessionCookieStrategy.refresh?.(STALE, wide, ctx);
    await sessionCookieStrategy.apply(refreshed ?? STALE, { kind: "http", request }, wide);

    expect(refreshed?.cookies).toEqual(STALE.cookies);
    expect(request.headers.get("cookie")).toBeNull();
  });

  it("can refresh only when the settings name a refresh request, reading unresolved settings", () => {
    const login = { url: "${env.APP_URL}/login", until: { cookie: "session" } };

    expect(
      sessionCookieStrategy.canRefresh?.(LOGGED_IN, {
        login,
        refresh: { request: "POST ${env.API_URL}/auth/refresh" },
      }),
    ).toBe(true);
    expect(sessionCookieStrategy.canRefresh?.(LOGGED_IN, { login })).toBe(false);
  });

  it("refresh fails when the server refuses the session", async () => {
    await expect(sessionCookieStrategy.refresh?.(STALE, config(), authContext())).rejects.toThrow(
      "the session refresh of customer answered 401",
    );
  });

  it("loads the storage state into a browser session", async () => {
    const session = new FakeBrowserSession();

    await sessionCookieStrategy.apply(LOGGED_IN, { kind: "browser", session }, config());

    expect(session.state).toEqual(LOGGED_IN);
  });

  it("secrets leaves out cookies a script can read that hold settings such as theme=dark", () => {
    const state: StorageState = {
      cookies: [
        cookie("session", "fake-session-1"),
        cookie("theme", "dark", { httpOnly: false }),
        cookie("consent", "accepted", { httpOnly: false }),
        cookie("lang", "en-GB", { httpOnly: false }),
        cookie("csrf", "fake-csrf-token-0001", { httpOnly: false }),
      ],
      origins: [],
    };

    expect(sessionCookieStrategy.secrets(state)).toEqual(["fake-session-1", "fake-csrf-token-0001"]);
  });

  it("secrets lists token-like localStorage values, also inside a JSON value", () => {
    const user = {
      email: "customer@example.test",
      stsTokenManager: { refreshToken: "fake-refresh-token-0001", expirationTime: 1762506000000 },
    };
    const state: StorageState = {
      cookies: [],
      origins: [
        {
          origin: "https://app.example.test",
          localStorage: [
            { name: "access_token", value: "fake-jwt.fake-payload-0001.fake-signature" },
            { name: "authUser", value: JSON.stringify(user) },
            { name: "theme", value: "dark" },
          ],
        },
      ],
    };

    expect(sessionCookieStrategy.secrets(state)).toEqual([
      "fake-jwt.fake-payload-0001.fake-signature",
      "fake-refresh-token-0001",
    ]);
  });

  it("the redactor masks the Cookie header and the credential's cookie values", async () => {
    const request = draft("GET", `${server.origin}/api/session/me`);
    await sessionCookieStrategy.apply(LOGGED_IN, { kind: "http", request }, config());
    const secrets = sessionCookieStrategy.secrets(LOGGED_IN);

    expect(redacted(secrets, `Cookie: ${request.headers.get("cookie")}`)).toBe(
      "Cookie: session=[redacted]; tracker=[redacted]",
    );
    expect(redacted(secrets, JSON.stringify(LOGGED_IN))).not.toMatch(/fake-session|fake-tracker/);
  });
});
