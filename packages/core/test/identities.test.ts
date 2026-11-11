import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  CredentialCache,
  CredentialRejected,
  defineAuthStrategy,
  Identities,
  IdentitiesConfig,
  IdentityMismatch,
  MissingHeaderCookie,
  withRefreshLock,
  type AuthContext,
  type AuthStrategy,
  type CredentialKey,
  type HttpRequestDraft,
  type IdentitiesDeps,
  type StorageState,
} from "../src/auth/index.ts";
import type { HumanChannel } from "../src/challenge/index.ts";
import { HostNotAllowed, type Environment } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION, PluginRegistry } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { FakeBrowserLogin, FakeBrowserSession } from "./support/fake-browser.ts";

const run = promisify(execFile);
const env: Environment = {
  name: "demo",
  production: false,
  vars: {},
  hosts: new Set(["app.example.test"]),
  challenges: {},
  locale: "en",
  probes: [],
};
const HOUR_MS = 60 * 60_000;
const SESSION_COOKIE = {
  name: "session",
  value: "fake-session-cookie",
  domain: "app.example.test",
};
const person: HumanChannel = { ask: async () => ({ kind: "timeout" }) };

type Token = { token: string; refreshToken: string; expiresAt: string };

interface TokenStrategyOptions {
  name?: string;
  cacheable?: boolean;
  refreshFails?: boolean;
  /** The refresh hands back the credential it was given, as one that keeps the account does. */
  refreshKeepsToken?: boolean;
  probe?: (credential: Token) => boolean;
  canRefresh?: (credential: Token) => boolean;
  /** Adds a field set to undefined, as a strategy does for a value the token endpoint left out. */
  undefinedField?: boolean;
}

/** Issues fake-<identity>-1, fake-<identity>-2 and so on, each valid for an hour, and logs each acquire and refresh. */
function tokenStrategy(clock: () => Date, options: TokenStrategyOptions = {}) {
  const calls: string[] = [];
  const contexts: AuthContext[] = [];
  let issued = 0;
  const issue = (identity: string): Token => {
    issued += 1;
    const expiresAt = new Date(clock().getTime() + HOUR_MS).toISOString();
    const token = {
      token: `fake-${identity}-${issued}`,
      refreshToken: `fake-refresh-${issued}`,
      expiresAt,
    };
    return options.undefinedField === true ? ({ ...token, scope: undefined } as Token) : token;
  };
  const strategy = defineAuthStrategy<{ audience: string }, Token>({
    name: options.name ?? "token",
    config: z.object({ audience: z.string() }),
    cacheable: options.cacheable ?? true,
    acquire: async (config, ctx) => {
      calls.push(`acquire ${ctx.identity} for ${config.audience}`);
      contexts.push(ctx);
      return issue(ctx.identity);
    },
    refresh: async (credential, _config, ctx) => {
      calls.push(`refresh ${credential.token}`);
      if (options.refreshFails === true) throw new Error("refresh token revoked");
      if (options.refreshKeepsToken === true) return credential;
      return issue(ctx.identity);
    },
    canRefresh: (credential) => options.canRefresh?.(credential) ?? true,
    expiresAt: (credential) => new Date(credential.expiresAt),
    probe: async (credential) => options.probe?.(credential) ?? true,
    apply: async (credential, target) => {
      const authorization = `Bearer ${credential.token}`;
      if (target.kind === "http") target.request.headers.set("authorization", authorization);
      else await target.session.setExtraHeaders({ authorization });
    },
    secrets: (credential) => [credential.token, credential.refreshToken],
  });
  return { strategy, calls, contexts };
}

/** Logs in through the browser, where a person finishes the login, and has no refresh. */
const cookieStrategy = defineAuthStrategy<{ loginUrl: string }, StorageState>({
  name: "cookie",
  config: z.object({ loginUrl: z.string() }),
  cacheable: true,
  needsPerson: () => true,
  acquire: async (config, ctx) => {
    if (ctx.browser === undefined) throw new Error("the cookie login needs browser.login");
    return (
      await ctx.browser.login({
        url: new URL(config.loginUrl),
        until: { cookie: "session" },
        timeoutMs: 1_000,
      })
    ).state;
  },
  apply: async (state, target) => {
    if (target.kind === "browser") return target.session.loadStorageState(state);
    const cookies = state.cookies as { name: string; value: string }[];
    target.request.headers.set(
      "cookie",
      cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    );
  },
  secrets: (state) => (state.cookies as { value: string }[]).map((cookie) => cookie.value),
});

/** Gets its token by posting to `tokenUrl` through `AuthContext.http`. */
const endpointStrategy = defineAuthStrategy<{ tokenUrl: string }, { accessToken: string }>({
  name: "endpoint",
  config: z.object({ tokenUrl: z.string() }),
  cacheable: false,
  acquire: async (config, ctx) => {
    const response = await ctx.http.send({
      method: "POST",
      url: new URL(config.tokenUrl),
      headers: new Headers(),
    });
    return { accessToken: (response.body as { accessToken: string }).accessToken };
  },
  apply: async (credential, target) => {
    if (target.kind === "http")
      target.request.headers.set("authorization", `Bearer ${credential.accessToken}`);
  },
  secrets: (credential) => [credential.accessToken],
});

const cookieSurface = { strategy: "cookie", with: { loginUrl: "https://app.example.test/login" } };
const tokenSurface = { strategy: "token", with: { audience: "orders" } };
const customerApiKey: CredentialKey = {
  env: "demo",
  identity: "customer",
  surface: "api",
  strategy: "token",
};

function draft(): HttpRequestDraft {
  return { method: "GET", url: new URL("https://app.example.test/me"), headers: new Headers() };
}

describe("Identities", () => {
  let root: string;
  let now: Date;
  const clock = () => now;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "identities-test-"));
    now = new Date("2026-11-06T09:00:00.000Z");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function identities(
    configs: unknown,
    strategies: AuthStrategy<any, any>[],
    deps: Partial<IdentitiesDeps> = {},
  ): Promise<Identities> {
    const plugin = definePlugin({
      name: "test-strategies",
      apiVersion: PLUGIN_API_VERSION,
      authStrategies: strategies,
    });
    return new Identities({
      env,
      configs: IdentitiesConfig.parse(configs),
      fixtures: { customer: { email: "customer@example.test" } },
      registry: await PluginRegistry.load(ProjectConfig.parse({ envs: {} }), root, [plugin]),
      cache: new CredentialCache(join(root, "credentials")),
      lockDir: join(root, "locks"),
      resolve: async (value) => value,
      redactor: new Redactor(defaultRedactionRules()),
      log: () => {},
      projectRoot: root,
      channel: person,
      now: clock,
      ...deps,
    });
  }

  async function cacheFiles(): Promise<string[]> {
    return readdir(join(root, "credentials")).catch(() => []);
  }

  it("uses one credential per identity and surface", async () => {
    const { strategy, calls } = tokenStrategy(clock);
    const auth = {
      web: { strategy: "token", with: { audience: "web" } },
      api: { strategy: "token", with: { audience: "api" } },
    };
    const ids = await identities({ customer: { auth }, admin: { auth } }, [strategy]);
    const customerPage = new FakeBrowserSession();
    const adminPage = new FakeBrowserSession();
    const customerRequest = draft();

    await ids.authorize("customer", "web", { kind: "browser", session: customerPage });
    await ids.authorize("admin", "web", { kind: "browser", session: adminPage });
    await ids.authorize("customer", "api", { kind: "http", request: customerRequest });
    await ids.authorize("customer", "web", { kind: "browser", session: customerPage });

    expect(customerPage.extraHeaders).toEqual({ authorization: "Bearer fake-customer-1" });
    expect(adminPage.extraHeaders).toEqual({ authorization: "Bearer fake-admin-2" });
    expect(customerRequest.headers.get("authorization")).toBe("Bearer fake-customer-3");
    expect(calls).toEqual([
      "acquire customer for web",
      "acquire admin for web",
      "acquire customer for api",
    ]);
  });

  it("reuses another surface with from:", async () => {
    const login = new FakeBrowserLogin([SESSION_COOKIE]);
    const ids = await identities(
      { customer: { auth: { web: cookieSurface, api: { strategy: "cookie", from: "web" } } } },
      [cookieStrategy],
      {
        browser: login,
      },
    );
    const page = new FakeBrowserSession();
    const request = draft();

    await ids.authorize("customer", "web", { kind: "browser", session: page });
    await ids.authorize("customer", "api", { kind: "http", request });

    expect(login.requests).toHaveLength(1);
    expect(page.state.cookies).toEqual([SESSION_COOKIE]);
    expect(request.headers.get("cookie")).toBe("session=fake-session-cookie");
    expect(await cacheFiles()).toEqual(["demo+customer+web+cookie.json"]);
  });

  it("runs acquire, apply, refresh for a strategy from defineAuthStrategy", async () => {
    const { strategy, calls, contexts } = tokenStrategy(clock);
    const ids = await identities(
      { customer: { fixture: "customer", auth: { api: tokenSurface } } },
      [strategy],
    );
    const first = draft();
    const second = draft();

    await ids.authorize("customer", "api", { kind: "http", request: first });
    now = new Date(now.getTime() + 2 * HOUR_MS);
    await ids.authorize("customer", "api", { kind: "http", request: second });

    expect(calls).toEqual(["acquire customer for orders", "refresh fake-customer-1"]);
    expect(contexts[0]?.fields).toEqual({ email: "customer@example.test" });
    expect(contexts[0]?.person).toBe(person);
    expect(contexts[0]?.projectRoot).toBe(root);
    expect(first.headers.get("authorization")).toBe("Bearer fake-customer-1");
    expect(second.headers.get("authorization")).toBe("Bearer fake-customer-2");
  });

  it("lets a strategy reach an allowed host through AuthContext.http and refuses a host outside the list", async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(
        `${request.method} ${request.url} ${request.headers.authorization ?? "no authorization"}`,
      );
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"accessToken":"fake-access-1"}');
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const { port } = server.address() as AddressInfo;
    try {
      const configs = {
        customer: {
          auth: {
            api: { strategy: "endpoint", with: { tokenUrl: `http://127.0.0.1:${port}/token` } },
          },
        },
        partner: {
          auth: {
            api: { strategy: "endpoint", with: { tokenUrl: "https://outside.example.test/token" } },
          },
        },
      };
      const ids = await identities(configs, [endpointStrategy], {
        env: { ...env, hosts: new Set(["127.0.0.1"]) },
      });
      const request = draft();

      await ids.authorize("customer", "api", { kind: "http", request });
      const refused = await ids.ensureCredential("partner", "api").catch((error: unknown) => error);

      expect(received).toEqual(["POST /token no authorization"]);
      expect(request.headers.get("authorization")).toBe("Bearer fake-access-1");
      expect(refused).toBeInstanceOf(HostNotAllowed);
      expect((refused as HostNotAllowed).host).toBe("outside.example.test");
    } finally {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  });

  it("calls log on the deps it was given when a strategy sends a request", async () => {
    const server = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"accessToken":"fake-access-1"}');
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const { port } = server.address() as AddressInfo;
    try {
      const plugin = definePlugin({
        name: "test-strategies",
        apiVersion: PLUGIN_API_VERSION,
        authStrategies: [endpointStrategy],
      });
      const tokenUrl = `http://127.0.0.1:${port}/token`;
      // a deps object whose log is a method that reads its own fields
      const deps: IdentitiesDeps & { lines: string[] } = {
        env: { ...env, hosts: new Set(["127.0.0.1"]) },
        configs: IdentitiesConfig.parse({
          customer: { auth: { api: { strategy: "endpoint", with: { tokenUrl } } } },
        }),
        fixtures: {},
        registry: await PluginRegistry.load(ProjectConfig.parse({ envs: {} }), root, [plugin]),
        cache: new CredentialCache(join(root, "credentials")),
        lockDir: join(root, "locks"),
        resolve: async (value) => value,
        redactor: new Redactor(defaultRedactionRules()),
        lines: [],
        log(line) {
          this.lines.push(line);
        },
        projectRoot: root,
        channel: person,
        now: clock,
      };

      await new Identities(deps).authorize("customer", "api", { kind: "http", request: draft() });

      expect(deps.lines).toEqual([`POST ${tokenUrl} 200`]);
    } finally {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  });

  it("never caches non-cacheable strategies, and masks their secrets", async () => {
    const { strategy } = tokenStrategy(clock, { name: "static-token", cacheable: false });
    const redactor = new Redactor(defaultRedactionRules());
    const ids = await identities(
      { partner: { auth: { api: { strategy: "static-token", with: { audience: "partner" } } } } },
      [strategy],
      {
        redactor,
      },
    );

    await ids.authorize("partner", "api", { kind: "http", request: draft() });

    expect(await cacheFiles()).toEqual([]);
    expect(redactor.text("sent fake-partner-1")).toBe("sent [redacted]");
  });

  it("reports each login mode without acquiring or refreshing", async () => {
    const token = tokenStrategy(clock);
    const staticToken = tokenStrategy(clock, { name: "static-token", cacheable: false });
    const configs = {
      customer: { auth: { api: tokenSurface, web: cookieSurface } },
      partner: { auth: { api: { strategy: "static-token", with: { audience: "partner" } } } },
    };
    const strategies = [token.strategy, staticToken.strategy, cookieStrategy];
    const ids = await identities(configs, strategies);

    const before = [
      await ids.credentialState("customer", "api"),
      await ids.credentialState("customer", "web"),
      await ids.credentialState("partner", "api"),
    ];
    await ids.ensureCredential("customer", "api");
    const nextProcess = await identities(configs, strategies);
    const cached = await nextProcess.credentialState("customer", "api");
    now = new Date(now.getTime() + 2 * HOUR_MS);
    const expired = await nextProcess.credentialState("customer", "api");

    expect(before).toEqual(["scripted", "person", "static"]);
    expect([cached, expired]).toEqual(["cached", "refresh"]);
    expect(token.calls).toEqual(["acquire customer for orders"]);
  });

  it("reports a person login without resolving the placeholders in its settings", async () => {
    const resolved: unknown[] = [];
    const surface = {
      strategy: "cookie",
      with: { loginUrl: "${env.APP_URL}/login", password: "${secret.CUSTOMER_PASSWORD}" },
    };
    const ids = await identities({ customer: { auth: { web: surface } } }, [cookieStrategy], {
      resolve: async (value) => {
        resolved.push(value);
        throw new Error("secret CUSTOMER_PASSWORD is not set");
      },
    });

    expect(await ids.credentialState("customer", "web")).toBe("person");
    expect(resolved).toEqual([]);
  });

  it("resolves the settings again after a resolve failed", async () => {
    const { strategy, calls } = tokenStrategy(clock);
    let attempts = 0;
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy], {
      resolve: async (value) => {
        attempts += 1;
        if (attempts === 1) throw new Error("op read timed out");
        return value;
      },
    });

    await expect(ids.ensureCredential("customer", "api")).rejects.toThrow("op read timed out");
    await ids.ensureCredential("customer", "api");

    expect(calls).toEqual(["acquire customer for orders"]);
  });

  it("reloads the cache after taking the lock", async () => {
    const staleProbed = Promise.withResolvers<void>();
    const { strategy, calls } = tokenStrategy(clock, {
      probe: (credential) => {
        if (credential.token !== "fake-stale") return true;
        staleProbed.resolve();
        return false;
      },
    });
    const cache = new CredentialCache(join(root, "credentials"));
    const expiresAt = new Date(now.getTime() + HOUR_MS).toISOString();
    await cache.save(customerApiKey, {
      token: "fake-stale",
      refreshToken: "fake-refresh-stale",
      expiresAt,
    });
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
    let ensured: Promise<void> | undefined;

    await withRefreshLock(join(root, "locks"), customerApiKey, async () => {
      ensured = ids.ensureCredential("customer", "api");
      await staleProbed.promise;
      // another process saves its refresh while this one waits for the lock
      await cache.save(customerApiKey, {
        token: "fake-from-other-process",
        refreshToken: "fake-refresh-other",
        expiresAt,
      });
    });
    await ensured;
    const request = draft();
    await ids.authorize("customer", "api", { kind: "http", request });

    expect(request.headers.get("authorization")).toBe("Bearer fake-from-other-process");
    expect(calls).toEqual([]);
  });

  it("acquires again when the refresh fails", async () => {
    const { strategy, calls } = tokenStrategy(clock, { refreshFails: true });
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);

    await ids.ensureCredential("customer", "api");
    now = new Date(now.getTime() + 2 * HOUR_MS);
    await ids.ensureCredential("customer", "api");

    expect(calls).toEqual([
      "acquire customer for orders",
      "refresh fake-customer-1",
      "acquire customer for orders",
    ]);
  });

  it("logs in again instead of refreshing when the strategy cannot refresh the credential", async () => {
    const { strategy, calls } = tokenStrategy(clock, { canRefresh: () => false });
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
    await ids.ensureCredential("customer", "api");

    const recovered = await ids.recoverFromUnauthorized("customer", "api");
    now = new Date(now.getTime() + 2 * HOUR_MS);
    const mode = await ids.credentialState("customer", "api");
    await ids.ensureCredential("customer", "api");

    expect([recovered, mode]).toEqual([false, "scripted"]);
    expect(calls).toEqual(["acquire customer for orders", "acquire customer for orders"]);
  });

  describe("refreshEveryMs", () => {
    const every = 120_000;

    it("names the owner surface and the interval, also through from:", async () => {
      const { strategy } = tokenStrategy(clock);
      const ids = await identities(
        {
          customer: {
            auth: {
              web: { ...tokenSurface, refreshEveryMs: every },
              api: { strategy: "token", from: "web" },
              mobile: tokenSurface,
            },
          },
        },
        [strategy],
      );

      expect(ids.refreshInterval("customer", "web")).toEqual({ surface: "web", everyMs: every });
      expect(ids.refreshInterval("customer", "api")).toEqual({ surface: "web", everyMs: every });
      expect(ids.refreshInterval("customer", "mobile")).toBeUndefined();
    });
  });

  describe("lostOn", () => {
    const lostOn = { url: "${env.APP_URL}/login*" };

    it("follows from: to the owner surface and fills the placeholders of its url", async () => {
      const { strategy } = tokenStrategy(clock);
      const ids = await identities(
        {
          customer: {
            auth: {
              web: { ...tokenSurface, lostOn },
              api: { strategy: "token", from: "web" },
              mobile: tokenSurface,
            },
          },
        },
        [strategy],
        {
          resolve: async (value) =>
            (value as string).replace("${env.APP_URL}", "https://app.example.test") as never,
        },
      );

      expect(await ids.lostOn("customer", "web")).toBe("https://app.example.test/login*");
      expect(await ids.lostOn("customer", "api")).toBe("https://app.example.test/login*");
      expect(await ids.lostOn("customer", "mobile")).toBeUndefined();
    });
  });

  describe("recoverOrLogIn", () => {
    it("refreshes when it can", async () => {
      const { strategy, calls } = tokenStrategy(clock);
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");

      expect(await ids.recoverOrLogIn("customer", "api")).toBe("refreshed");
      expect(calls).toEqual(["acquire customer for orders", "refresh fake-customer-1"]);
    });

    it("logs in when the strategy cannot refresh", async () => {
      const { strategy, calls } = tokenStrategy(clock, { canRefresh: () => false });
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");

      expect(await ids.recoverOrLogIn("customer", "api")).toBe("loggedIn");
      const request = draft();
      await ids.authorize("customer", "api", { kind: "http", request });

      expect(request.headers.get("authorization")).toBe("Bearer fake-customer-2");
      expect(calls).toEqual(["acquire customer for orders", "acquire customer for orders"]);
    });

    it("logs in when the refresh throws", async () => {
      const { strategy, calls } = tokenStrategy(clock, { refreshFails: true });
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");

      expect(await ids.recoverOrLogIn("customer", "api")).toBe("loggedIn");
      expect(calls).toEqual([
        "acquire customer for orders",
        "refresh fake-customer-1",
        "acquire customer for orders",
      ]);
    });

    it("adopts a credential another process saved", async () => {
      const { strategy, calls } = tokenStrategy(clock, { canRefresh: () => false });
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");
      const expiresAt = new Date(now.getTime() + HOUR_MS).toISOString();
      await new CredentialCache(join(root, "credentials")).save(customerApiKey, {
        token: "fake-from-other-process",
        refreshToken: "fake-refresh-other",
        expiresAt,
      });

      expect(await ids.recoverOrLogIn("customer", "api")).toBe("refreshed");
      const request = draft();
      await ids.authorize("customer", "api", { kind: "http", request });

      expect(request.headers.get("authorization")).toBe("Bearer fake-from-other-process");
      expect(calls).toEqual(["acquire customer for orders"]);
    });

    it("logs in instead of refreshing a saved credential of another account", async () => {
      const { strategy, calls } = tokenStrategy(clock, {
        probe: (credential) => {
          if (credential.token === "fake-from-other-process")
            throw new IdentityMismatch(["body.user_id"]);
          return true;
        },
      });
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");
      const cache = new CredentialCache(join(root, "credentials"));
      await cache.save(customerApiKey, {
        token: "fake-from-other-process",
        refreshToken: "fake-refresh-other",
        expiresAt: new Date(now.getTime() + HOUR_MS).toISOString(),
      });

      expect(await ids.recoverOrLogIn("customer", "api")).toBe("loggedIn");
      expect(calls).toEqual(["acquire customer for orders", "acquire customer for orders"]);
      expect((await cache.load(customerApiKey))?.credential).toMatchObject({
        token: "fake-customer-2",
      });
    });

    it("does nothing for a strategy that caches nothing", async () => {
      const { strategy, calls } = tokenStrategy(clock, { cacheable: false });
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");

      expect(await ids.recoverOrLogIn("customer", "api")).toBe("none");
      expect(calls).toEqual(["acquire customer for orders"]);
    });

    it("throws CredentialRejected and caches nothing new when the new login fails its probe", async () => {
      let healthy = true;
      const { strategy } = tokenStrategy(clock, { canRefresh: () => false, probe: () => healthy });
      const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
      await ids.ensureCredential("customer", "api");
      const before = await new CredentialCache(join(root, "credentials")).load(customerApiKey);
      healthy = false;

      await expect(ids.recoverOrLogIn("customer", "api")).rejects.toBeInstanceOf(
        CredentialRejected,
      );
      expect(await new CredentialCache(join(root, "credentials")).load(customerApiKey)).toEqual(
        before,
      );
    });
  });

  it("throws CredentialRejected and saves nothing when a new credential fails the probe", async () => {
    const { strategy } = tokenStrategy(clock, { probe: () => false });
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);

    await expect(ids.ensureCredential("customer", "api")).rejects.toBeInstanceOf(
      CredentialRejected,
    );
    expect(await cacheFiles()).toEqual([]);
  });

  it("blocks with the paths when a new credential belongs to another account, and saves nothing", async () => {
    const { strategy } = tokenStrategy(clock, {
      probe: () => {
        throw new IdentityMismatch(["body.user_id"]);
      },
    });
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);

    await expect(ids.ensureCredential("customer", "api")).rejects.toThrow(
      "the new token credential for customer/api belongs to another account: body.user_id does not match",
    );
    expect(await cacheFiles()).toEqual([]);
  });

  it("logs in again when the cached credential belongs to another account, and probe reports false", async () => {
    let mismatched = false;
    const { strategy, calls } = tokenStrategy(clock, {
      refreshKeepsToken: true,
      probe: (credential) => {
        if (mismatched && credential.token === "fake-customer-1")
          throw new IdentityMismatch(["body.user_id"]);
        return true;
      },
    });
    const first = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
    await first.ensureCredential("customer", "api");
    mismatched = true;
    const second = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);

    await second.ensureCredential("customer", "api");

    expect(calls).toEqual(["acquire customer for orders", "acquire customer for orders"]);
    expect(await second.probe("customer", "api")).toBe(true);
    expect(await first.probe("customer", "api")).toBe(false);
  });

  it("logs in again when the probe header needs a cookie the cached state lacks, and says so when the new one lacks it too", async () => {
    const missing = new MissingHeaderCookie(
      "probe",
      "customer",
      "csrf",
      "x-csrf-token",
      "https://app.example.test",
    );
    let lacking = false;
    const { strategy, calls } = tokenStrategy(clock, {
      canRefresh: () => false,
      probe: (credential) => {
        if (lacking && credential.token === "fake-customer-1") throw missing;
        return true;
      },
    });
    const first = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
    await first.ensureCredential("customer", "api");
    lacking = true;
    const second = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);

    await second.ensureCredential("customer", "api");

    expect(calls).toEqual(["acquire customer for orders", "acquire customer for orders"]);
    const always = tokenStrategy(clock, {
      name: "always-lacking",
      probe: () => {
        throw missing;
      },
    });
    const third = await identities(
      { other: { auth: { api: { strategy: "always-lacking", with: { audience: "x" } } } } },
      [always.strategy],
    );
    await expect(third.ensureCredential("other", "api")).rejects.toThrow(missing.message);
  });

  it("refreshes once on a 401 and saves the new credential for the retry", async () => {
    const { strategy, calls } = tokenStrategy(clock);
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
    await ids.ensureCredential("customer", "api");
    const retry = draft();

    const recovered = await ids.recoverFromUnauthorized("customer", "api");
    await ids.authorize("customer", "api", { kind: "http", request: retry });

    expect(recovered).toBe(true);
    expect(calls).toEqual(["acquire customer for orders", "refresh fake-customer-1"]);
    expect(retry.headers.get("authorization")).toBe("Bearer fake-customer-2");
    expect(await new CredentialCache(join(root, "credentials")).load(customerApiKey)).toMatchObject(
      {
        credential: { token: "fake-customer-2" },
      },
    );
  });

  it("refreshes on a 401 when the credential holds a field set to undefined", async () => {
    const { strategy, calls } = tokenStrategy(clock, { undefinedField: true });
    const ids = await identities({ customer: { auth: { api: tokenSurface } } }, [strategy]);
    await ids.ensureCredential("customer", "api");

    expect(await ids.recoverFromUnauthorized("customer", "api")).toBe(true);
    expect(calls).toEqual(["acquire customer for orders", "refresh fake-customer-1"]);
  });

  it("second 401 blocks: recoverFromUnauthorized returns false when the strategy cannot refresh", async () => {
    const ids = await identities({ customer: { auth: { web: cookieSurface } } }, [cookieStrategy], {
      browser: new FakeBrowserLogin([SESSION_COOKIE]),
    });
    await ids.ensureCredential("customer", "web");

    expect(await ids.recoverFromUnauthorized("customer", "web")).toBe(false);
  });

  it("two processes refreshing a single-use token both end valid", async () => {
    const server = await startTokenServer();
    try {
      const key: CredentialKey = {
        env: "demo",
        identity: "customer",
        surface: "api",
        strategy: "single-use",
      };
      const expired = new Date(Date.now() - 60_000);
      const stale = {
        accessToken: "fake-access-0",
        refreshToken: "fake-refresh-0",
        expiresAt: expired.toISOString(),
      };
      await new CredentialCache(join(root, "credentials")).save(key, stale, expired);
      const modules = [
        "../src/auth/index.ts",
        "../src/plugin/index.ts",
        "../src/redact/index.ts",
        "../src/project.ts",
      ].map((path) => new URL(path, import.meta.url).href);
      const coreDir = fileURLToPath(new URL("..", import.meta.url));
      const start = () =>
        run(
          process.execPath,
          ["--input-type=module", "-e", REFRESH_WORKER, ...modules, root, server.url],
          {
            cwd: coreDir,
          },
        );

      const [first, second] = await Promise.all([start(), start()]);

      expect([first.stdout, second.stdout]).toEqual([
        "Bearer fake-access-1",
        "Bearer fake-access-1",
      ]);
      expect(server.issued).toEqual(["fake-access-1"]);
    } finally {
      await server.close();
    }
  }, 30_000);
});

describe("IdentitiesConfig", () => {
  describe("refreshEveryMs", () => {
    const parse = (surface: unknown) =>
      IdentitiesConfig.safeParse({ customer: { auth: { web: surface } } });

    it("takes 10000 or more beside with:, and is refused beside from:", () => {
      expect(parse({ ...tokenSurface, refreshEveryMs: 10_000 }).success).toBe(true);
      expect(parse({ ...tokenSurface, refreshEveryMs: 9_999 }).success).toBe(false);
      expect(parse({ ...tokenSurface, refreshEveryMs: 12_000.5 }).success).toBe(false);
      const reused = IdentitiesConfig.safeParse({
        customer: {
          auth: {
            web: tokenSurface,
            api: { strategy: "token", from: "web", refreshEveryMs: 120_000 },
          },
        },
      });
      expect(reused.success).toBe(false);
    });
  });

  it("refuses lostOn beside from:", () => {
    const lostOn = { url: "https://app.example.test/login*" };
    const result = IdentitiesConfig.safeParse({
      customer: { auth: { web: tokenSurface, api: { strategy: "token", from: "web", lostOn } } },
    });

    expect(result.success).toBe(false);
    expect(
      IdentitiesConfig.safeParse({ customer: { auth: { web: { ...tokenSurface, lostOn } } } })
        .success,
    ).toBe(true);
  });

  it("rejects from: naming another strategy or a surface that has no settings of its own", () => {
    const result = IdentitiesConfig.safeParse({
      customer: {
        auth: {
          web: cookieSurface,
          api: { strategy: "token", from: "web" },
          mobile: { strategy: "cookie", from: "api" },
        },
      },
    });

    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      [
        "customer.auth.api.from",
        'surface "web" uses strategy cookie, not token; give surface "api" strategy: cookie or point its from: at a surface that uses strategy token',
      ],
      [
        "customer.auth.mobile.from",
        'from: "api" must name a surface of this identity with its own settings',
      ],
    ]);
  });
});

// Runs in a separate Node process: refreshes the cached credential through the token server, whose refresh
// tokens work once, and prints the Authorization header it ends with. Acquire throws, so losing the race fails.
const REFRESH_WORKER = `
const [authModule, pluginModule, redactModule, projectModule, root, server] = process.argv.slice(1);
const { CredentialCache, defineAuthStrategy, Identities, IdentitiesConfig } = await import(authModule);
const { definePlugin, PLUGIN_API_VERSION, PluginRegistry } = await import(pluginModule);
const { defaultRedactionRules, Redactor } = await import(redactModule);
const { ProjectConfig } = await import(projectModule);
const { z } = await import("zod");
const { join } = await import("node:path");

const strategy = defineAuthStrategy({
  name: "single-use",
  config: z.object({ tokenUrl: z.string() }),
  cacheable: true,
  acquire: async () => {
    throw new Error("acquire needs a person");
  },
  refresh: async (credential, config) => {
    const response = await fetch(config.tokenUrl, { method: "POST", body: credential.refreshToken });
    if (!response.ok) throw new Error("refresh refused with " + response.status);
    return { ...(await response.json()), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  },
  expiresAt: (credential) => new Date(credential.expiresAt),
  apply: async (credential, target) => target.request.headers.set("authorization", "Bearer " + credential.accessToken),
  secrets: (credential) => [credential.accessToken, credential.refreshToken],
});
const plugin = definePlugin({ name: "single-use", apiVersion: PLUGIN_API_VERSION, authStrategies: [strategy] });
const identities = new Identities({
  env: { name: "demo", production: false, vars: {}, hosts: new Set(), challenges: {}, locale: "en", probes: [] },
  configs: IdentitiesConfig.parse({ customer: { auth: { api: { strategy: "single-use", with: { tokenUrl: server + "/refresh" } } } } }),
  fixtures: {},
  registry: await PluginRegistry.load(ProjectConfig.parse({ envs: {} }), root, [plugin]),
  cache: new CredentialCache(join(root, "credentials")),
  lockDir: join(root, "locks"),
  resolve: async (value) => value,
  redactor: new Redactor(defaultRedactionRules()),
  log: () => {},
  projectRoot: root,
  channel: { ask: async () => ({ kind: "timeout" }) },
  now: () => new Date(),
});
// both processes start refreshing at the same moment
await fetch(server + "/barrier");
const request = { method: "GET", url: new URL(server + "/me"), headers: new Headers() };
await identities.authorize("customer", "api", { kind: "http", request });
process.stdout.write(request.headers.get("authorization"));
`;

interface TokenServer {
  url: string;
  /** Access tokens issued so far. */
  issued: string[];
  close(): Promise<void>;
}

/** Each refresh token works once; a refresh answers after 300 ms so the second process meets a held lock. */
async function startTokenServer(): Promise<TokenServer> {
  let validRefreshToken = "fake-refresh-0";
  let atBarrier: ServerResponse[] = [];
  const issued: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/barrier") {
      atBarrier.push(response);
      if (atBarrier.length === 2) {
        for (const waiting of atBarrier) waiting.end();
        atBarrier = [];
      }
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    await sleep(300);
    if (body !== validRefreshToken) {
      response.writeHead(400).end('{"error":"invalid_grant"}');
      return;
    }
    issued.push(`fake-access-${issued.length + 1}`);
    validRefreshToken = `fake-refresh-${issued.length}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accessToken: issued.at(-1), refreshToken: validRefreshToken }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    issued,
    close: () =>
      new Promise((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}
