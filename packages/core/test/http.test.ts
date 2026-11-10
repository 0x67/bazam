import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import {
  CredentialCache,
  defineAuthStrategy,
  Identities,
  IdentitiesConfig,
  type HttpRequestDraft,
} from "../src/auth/index.ts";
import type { StepContext } from "../src/driver/index.ts";
import { ConnectionFailed, guardedHttp, httpSteps, Unauthorized, type GuardedHttp } from "../src/driver/http.ts";
import {
  EnvsConfig,
  HostNotAllowed,
  ProdWriteRefused,
  resolvePlaceholders,
  type Environment,
} from "../src/env/index.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { EvidenceStore, type CheckRecord } from "../src/result/index.ts";

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  cookie: string | undefined;
  body: string;
}

const seen: SeenRequest[] = [];
const servers: Server[] = [];

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function redirect(res: ServerResponse, status: number, location: string): void {
  res.writeHead(status, { location }).end();
}

type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** Serves `route` on 127.0.0.1 and records every request; returns the origin. */
async function serve(route: Route): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      seen.push({
        method: req.method ?? "",
        path,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      route(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// fake-customer-1 is the token from the login, fake-customer-2 the one from the first refresh
function api(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/").split("?")[0];
  switch (`${req.method} ${path}`) {
    case "GET /me":
      return req.headers.authorization === "Bearer fake-customer-2"
        ? json(res, 200, { name: "customer" })
        : json(res, 401, {});
    case "GET /locked":
      return json(res, 401, {});
    case "POST /orders":
      return json(res, 201, { id: 42, items: [{ sku: "sku-1" }] }, { "x-request-id": "req-1" });
    case "GET /orders/42":
      return json(res, 200, { status: "PAID", items: [{ id: 7 }] });
    case "GET /hop":
      return redirect(res, 302, "/away");
    case "GET /away":
      return redirect(res, 302, "http://outside.example.test/");
    default:
      return json(res, 404, {});
  }
}

function tokenStrategy() {
  let issued = 0;
  const issue = (identity: string) => {
    issued += 1;
    return { token: `fake-${identity}-${issued}` };
  };
  return defineAuthStrategy<Record<string, never>, { token: string }>({
    name: "token",
    config: z.strictObject({}),
    cacheable: false,
    acquire: async (_config, ctx) => issue(ctx.identity),
    refresh: async (_credential, _config, ctx) => issue(ctx.identity),
    apply: async (credential, target) => {
      if (target.kind === "http") target.request.headers.set("authorization", `Bearer ${credential.token}`);
    },
    secrets: (credential) => [credential.token],
  });
}

describe("http", () => {
  let origin: string;
  let demo: Environment;
  let live: Environment;
  let root: string;
  let redactor: Redactor;
  let logLines: string[];

  beforeAll(async () => {
    origin = await serve(api);
    const envs = EnvsConfig.parse({
      demo: { production: false, vars: { API_URL: origin }, hosts: ["127.0.0.1"] },
      live: { production: true, vars: { API_URL: origin }, hosts: ["127.0.0.1"] },
    });
    demo = envs["demo"]!;
    live = envs["live"]!;
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "http-test-"));
    redactor = new Redactor(defaultRedactionRules());
    logLines = [];
    seen.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function identities(env: Environment): Identities {
    const strategy = tokenStrategy();
    return new Identities({
      env,
      configs: IdentitiesConfig.parse({ customer: { auth: { api: { strategy: "token" } } } }),
      fixtures: {},
      registry: { strategy: () => strategy },
      cache: new CredentialCache(join(root, "credentials")),
      lockDir: join(root, "locks"),
      resolve: async (value) => value,
      redactor,
      log: (line) => logLines.push(line),
      projectRoot: root,
      channel: { ask: async () => ({ kind: "timeout" }) },
      now: () => new Date(),
    });
  }

  function client(env: Environment = demo): GuardedHttp {
    return guardedHttp({ env, redactor, log: (line) => logLines.push(line), identities: identities(env) });
  }

  function get(path: string, headers: Record<string, string> = {}): HttpRequestDraft {
    return { method: "GET", url: new URL(path, origin), headers: new Headers(headers) };
  }

  const customer = { identity: "customer", surface: "api" };

  describe("GuardedHttp", () => {
    it("retries once after a 401", async () => {
      const response = await client().send(get("/me"), customer);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ name: "customer" });
      expect(seen.map((request) => request.authorization)).toEqual([
        "Bearer fake-customer-1",
        "Bearer fake-customer-2",
      ]);
    });

    it("throws Unauthorized after a second 401", async () => {
      await expect(client().send(get("/locked"), customer)).rejects.toThrow(Unauthorized);
      expect(seen).toHaveLength(2);
    });

    it("checks every redirect hop against the host allowlist", async () => {
      const failure = await client()
        .send(get("/hop"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HostNotAllowed);
      expect((failure as HostNotAllowed).host).toBe("outside.example.test");
      expect(seen.map((request) => request.path)).toEqual(["/hop", "/away"]);
    });

    it("sends no credentials after a redirect to another origin", async () => {
      const otherOrigin = await serve((_req, res) => json(res, 200, {}));
      const moving = await serve((_req, res) => redirect(res, 307, `${otherOrigin}/landing`));
      const request = {
        method: "GET",
        url: new URL("/start", moving),
        headers: new Headers({ cookie: "session=fake-session" }),
      };

      await client().send(request, customer);

      expect(seen.map(({ path, authorization, cookie }) => [path, authorization, cookie])).toEqual([
        ["/start", "Bearer fake-customer-1", "session=fake-session"],
        ["/landing", undefined, undefined],
      ]);
    });

    it("throws ConnectionFailed, naming the request and the socket error, when the host refuses the connection", async () => {
      const closed = createServer();
      await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
      const { port } = closed.address() as AddressInfo;
      await new Promise((done) => closed.close(done));
      const request = {
        method: "GET",
        url: new URL(`http://127.0.0.1:${port}/health?code=fake-code`),
        headers: new Headers(),
      };

      const failure = await client()
        .send(request)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConnectionFailed);
      expect((failure as ConnectionFailed).message).toBe(
        `GET http://127.0.0.1:${port}/health?code=[redacted] got no answer: connect ECONNREFUSED 127.0.0.1:${port}`,
      );
      expect((failure as ConnectionFailed).host).toBe("127.0.0.1");
    });

    it.each([
      ["while the server holds it", "GET", "/held"],
      ["after a 303 turned it into a GET", "POST", "/see-other"],
    ])("rejects with the abort reason and closes the socket when a send is aborted %s", async (_, method, path) => {
      let arrived!: () => void;
      const held = new Promise<void>((done) => (arrived = done));
      let closed!: Promise<string>;
      const holding = await serve((req, res) => {
        if (req.url === "/see-other") return redirect(res, 303, "/held");
        closed = new Promise((done) => req.socket.once("close", () => done("closed")));
        arrived();
      });
      const abort = new AbortController();
      const sending = client()
        .send({ method, url: new URL(path, holding), headers: new Headers(), signal: abort.signal })
        .catch((error: unknown) => error);
      await held;

      abort.abort();

      expect(await Promise.race([sending, sleep(1000, "still pending")])).toBe(abort.signal.reason);
      expect(await Promise.race([closed, sleep(1000, "still open")])).toBe("closed");
    });

    it("logs the method, path and status with every query value masked and no header value", async () => {
      await client().send(get("/orders/42?code=fake-query-code", { "x-trace": "fake-trace-value" }), customer);

      expect(logLines).toEqual([`GET ${origin}/orders/42?code=[redacted] 200`]);
    });
  });

  describe("httpSteps", () => {
    function stepContext(env: Environment, identity?: string): { ctx: StepContext; checks: () => CheckRecord[] } {
      const values = new Map<string, string>();
      const evidence = new EvidenceStore(root, "API-ORDER-001", redactor);
      const record = vi.spyOn(evidence, "record");
      const ctx: StepContext = {
        session: { capabilities: new Set(), close: async () => {} },
        ...(identity === undefined ? {} : { identity }),
        env,
        evidence,
        identities: identities(env),
        values,
        http: client(env),
        resolve: (value) =>
          resolvePlaceholders(value, {
            env: (key) => env.vars[key],
            secret: async () => undefined,
            identity: () => undefined,
            run: () => undefined,
            case: (key) => values.get(key),
            locale: env.locale,
          }),
        signal: new AbortController().signal,
      };
      return { ctx, checks: () => record.mock.calls.map(([check]) => check) };
    }

    async function runStep(step: Record<string, unknown>, ctx: StepContext): Promise<void> {
      const [kind, payload] = Object.entries(step)[0]!;
      const handler = httpSteps.find((candidate) => candidate.kind === kind)!;
      await handler.run(handler.schema.parse(payload), ctx);
    }

    it("save exposes ${case.name}", async () => {
      const { ctx } = stepContext(demo);
      const save = {
        orderId: "body.id",
        sku: "body.items[0].sku",
        requestId: "headers.x-request-id",
        created: "status",
      };

      await runStep(
        { request: { method: "POST", url: "${env.API_URL}/orders", as: "customer", json: { amount: 10 }, save } },
        ctx,
      );
      await runStep({ api: { request: "GET ${env.API_URL}/orders/${case.orderId}", status: 200 } }, ctx);

      expect(Object.fromEntries(ctx.values)).toEqual({
        orderId: "42",
        sku: "sku-1",
        requestId: "req-1",
        created: "201",
      });
      expect(seen.map(({ method, path, body }) => [method, path, body])).toEqual([
        ["POST", "/orders", '{"amount":10}'],
        ["GET", "/orders/42", ""],
      ]);
    });

    it("refuses save names id and title, which ${case.id} and ${case.title} read", async () => {
      const { ctx } = stepContext(demo);

      for (const name of ["id", "title"]) {
        await expect(
          runStep({ request: { method: "POST", url: "${env.API_URL}/orders", save: { [name]: "body.id" } } }, ctx),
        ).rejects.toThrow("save cannot use the names id and title");
      }
      expect(seen).toEqual([]);
    });

    it("api check compares status and body paths", async () => {
      const { ctx, checks } = stepContext(demo, "customer");

      await runStep(
        { api: { request: "GET ${env.API_URL}/orders/42", status: 200, body: { status: "PAID", "items[0].id": "7" } } },
        ctx,
      );
      await runStep(
        { api: { request: "GET ${env.API_URL}/orders/42", body: { status: "REFUNDED", "items[1].id": 8 } } },
        ctx,
      );

      expect(checks()).toEqual([
        {
          name: "GET ${env.API_URL}/orders/42",
          kind: "api",
          expected: { status: 200, "body.status": "PAID", "body.items[0].id": "7" },
          observed: { status: 200, "body.status": "PAID", "body.items[0].id": 7 },
          ok: true,
        },
        {
          name: "GET ${env.API_URL}/orders/42",
          kind: "api",
          expected: { "body.status": "REFUNDED", "body.items[1].id": 8 },
          observed: { "body.status": "PAID", "body.items[1].id": undefined },
          ok: false,
        },
      ]);
      expect(seen.map((request) => request.authorization)).toEqual([
        "Bearer fake-customer-1",
        "Bearer fake-customer-1",
      ]);
    });

    it("sends an api check without credentials when neither the check nor the step names an identity", async () => {
      const { ctx, checks } = stepContext(demo);

      await runStep({ api: { request: "GET ${env.API_URL}/me", status: 401 } }, ctx);

      expect(checks().map((check) => check.ok)).toEqual([true]);
      expect(seen.map((request) => request.authorization)).toEqual([undefined]);
    });

    it.each([
      ["request step", { request: { method: "POST", url: "${env.API_URL}/orders", json: { amount: 10 } } }],
      ["api check", { api: { request: "DELETE ${env.API_URL}/orders/42", status: 204 } }],
    ])("refuses a non-GET %s without write: true in production", async (_, step) => {
      const { ctx } = stepContext(live, "customer");

      await expect(runStep(step, ctx)).rejects.toThrow(ProdWriteRefused);
      expect(seen).toEqual([]);
    });
  });
});
