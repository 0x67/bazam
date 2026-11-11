import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CaseSpec, type FlowSpec, type LoadedCase } from "../src/case/index.ts";
import { ConnectionFailed, guardedHttp } from "../src/driver/index.ts";
import { EnvsConfig } from "../src/env/index.ts";
import type { Project } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { blockUnreachable, caseHosts, probeEnv, probeHint } from "../src/run/env-probes.ts";
import type { PlannedCase, RunPlan } from "../src/run/index.ts";

const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function envWith(probes: object[], hosts = ["127.0.0.1"]) {
  return EnvsConfig.parse({
    uat: {
      production: false,
      vars: { CORE_URL: "https://core.example.test", ID: "7" },
      hosts,
      probes,
    },
  })["uat"]!;
}

function http(env: ReturnType<typeof envWith>) {
  return guardedHttp({ env, redactor: new Redactor(defaultRedactionRules()), log: () => {} });
}

describe("probeEnv", () => {
  it("passes a 2xx answer and a status that matches, and fails a wrong status naming it and the hint", async () => {
    const origin = await listen((req, res) =>
      res.writeHead(req.url === "/gone" ? 404 : req.url === "/made" ? 201 : 200).end(),
    );
    const env = envWith([
      { request: `GET ${origin}/health`, hint: "start the app" },
      { request: `HEAD ${origin}/made`, status: 201, hint: "start the app" },
      { request: `GET ${origin}/gone`, hint: "connect the VPN" },
    ]);

    expect(await probeEnv(env, http(env), new AbortController().signal)).toEqual([
      { host: "127.0.0.1", reason: `GET ${origin}/gone failed: answered 404; connect the VPN` },
    ]);
  });

  it("does not follow a redirect, so a 302 is not a 2xx", async () => {
    const origin = await listen((_req, res) =>
      res.writeHead(302, { location: "/elsewhere" }).end(),
    );
    const env = envWith([{ request: `GET ${origin}/health`, hint: "log in" }]);

    expect(await probeEnv(env, http(env), new AbortController().signal)).toEqual([
      { host: "127.0.0.1", reason: `GET ${origin}/health failed: answered 302; log in` },
    ]);
  });

  it("reports a refused port with the connection error", async () => {
    const origin = await listen(() => {});
    servers.pop()!.close();
    await new Promise((done) => setTimeout(done, 20));
    const env = envWith([{ request: `GET ${origin}/health`, hint: "start the app" }]);

    const [failure] = await probeEnv(env, http(env), new AbortController().signal);

    expect(failure?.reason).toBe(
      `GET ${origin}/health failed: connect ECONNREFUSED ${origin.slice("http://".length)}; start the app`,
    );
  });

  it("gives up on a host that never answers after 5 seconds", async () => {
    const origin = await listen(() => {});
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(20));
    const env = envWith([{ request: `GET ${origin}/health`, hint: "connect the VPN" }]);

    expect(await probeEnv(env, http(env), new AbortController().signal)).toEqual([
      {
        host: "127.0.0.1",
        reason: `GET ${origin}/health failed: timed out after 5 s; connect the VPN`,
      },
    ]);
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it("fails no probe that the run's cancel stopped", async () => {
    const origin = await listen(() => {});
    const env = envWith([{ request: `GET ${origin}/health`, hint: "x" }]);
    const cancel = new AbortController();
    const done = probeEnv(env, http(env), cancel.signal);
    cancel.abort(new Error("run stopped"));

    await expect(done).resolves.toEqual([]);
  });
});

const flows = new Map<string, FlowSpec>([
  [
    "sign-in",
    {
      name: "sign-in",
      params: [],
      steps: [{ request: { method: "GET", url: "https://auth.example.test/login" } }],
    },
  ],
]);
const project = {
  flows,
  config: {
    identities: {
      ops: {
        auth: {
          web: {
            strategy: "session-cookie",
            with: { login: { url: "${env.CORE_URL}/login" }, token: "${secret.X}" },
          },
          api: { strategy: "session-cookie", from: "web" },
        },
      },
      other: {
        auth: {
          web: {
            strategy: "session-cookie",
            with: { login: { url: "https://other.example.test/in" } },
          },
        },
      },
    },
  },
} as unknown as Project;

function spec(fields: object): CaseSpec {
  return CaseSpec.parse({
    id: "OPS-PROBE-001",
    title: "case",
    stage: "acceptance",
    risk: "low",
    targets: ["web"],
    ...fields,
  });
}

describe("caseHosts", () => {
  const env = envWith([], ["core.example.test"]);

  it("reads steps, a flow, a finally step and the settings of the listed identities, with env placeholders filled", () => {
    const hosts = caseHosts(
      spec({
        steps: [
          { request: { method: "GET", url: "${env.CORE_URL}/a" } },
          { use: "sign-in" },
          { request: { method: "GET", url: "https://api.example.test:8443/v1" } },
        ],
        checks: [{ request: { method: "GET", url: "https://checks.example.test/me" } }],
        finally: [{ request: { method: "POST", url: "https://cleanup.example.test/reset" } }],
      }),
      project,
      env,
      ["ops"],
    );

    expect([...hosts].sort()).toEqual([
      "api.example.test",
      "auth.example.test",
      "checks.example.test",
      "cleanup.example.test",
      "core.example.test",
    ]);
  });

  it("stops a URL before the punctuation of the prose around it", () => {
    const hosts = caseHosts(
      spec({
        steps: [
          {
            request: {
              method: "GET",
              url: "https://x.example.test/p",
              json: {
                note: "see https://a.example.test, then (https://b.example.test) and https://c.example.test.",
              },
            },
          },
        ],
      }),
      project,
      env,
      [],
    );

    expect([...hosts].sort()).toEqual([
      "a.example.test",
      "b.example.test",
      "c.example.test",
      "x.example.test",
    ]);
  });

  it("leaves out the identities the case does not list and text that is not a URL", () => {
    const hosts = caseHosts(
      spec({ steps: [{ request: { method: "GET", url: "${env.MISSING}/b" } }] }),
      project,
      env,
      [],
    );

    expect([...hosts]).toEqual([]);
  });
});

describe("blockUnreachable", () => {
  it("blocks only the unblocked cases that name a failed host", () => {
    const env = envWith([], ["core.example.test"]);
    const planned = (caseId: string, blocked?: string): PlannedCase => ({
      caseId,
      target: "web",
      stage: "acceptance",
      identities: [],
      logins: [],
      challenges: [],
      ...(blocked === undefined ? {} : { blocked }),
    });
    const plan: RunPlan = {
      env: "uat",
      cases: [planned("A"), planned("B"), planned("C", "earlier reason")],
      confirmations: [],
      personSteps: 0,
      roles: {},
    };
    const cases = [
      {
        spec: spec({
          id: "OPS-PROBE-101",
          steps: [{ request: { method: "GET", url: "https://core.example.test/a" } }],
        }),
      },
      {
        spec: spec({
          id: "OPS-PROBE-102",
          steps: [{ request: { method: "GET", url: "https://app.example.test/a" } }],
        }),
      },
      {
        spec: spec({
          id: "OPS-PROBE-103",
          steps: [{ request: { method: "GET", url: "https://core.example.test/a" } }],
        }),
      },
    ] as LoadedCase[];

    blockUnreachable(plan, cases, project, env, [
      { host: "core.example.test", reason: "probe failed" },
    ]);

    expect(plan.cases.map((c) => c.blocked)).toEqual(["probe failed", undefined, "earlier reason"]);
  });
});

describe("probeHint", () => {
  const env = envWith(
    [{ request: "GET https://core.example.test/health", hint: "connect the VPN" }],
    ["core.example.test", "other.example.test"],
  );

  it("gives the hint of the probe for the host a connection failure names", () => {
    const failed = (host: string) =>
      new ConnectionFailed("GET https://x.test/", "refused", { host });

    expect(probeHint(env, failed("core.example.test"))).toBe("connect the VPN");
    expect(probeHint(env, failed("other.example.test"))).toBeUndefined();
    expect(probeHint(env, new Error("core.example.test"))).toBeUndefined();
  });
});
