import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { apiKeyStrategy } from "../src/auth/strategies/index.ts";
import { BRAND } from "../src/brand.ts";
import type { CheckRule } from "../src/check/index.ts";
import { RunValues } from "../src/env/index.ts";
import { definePlugin, PLUGIN_API_VERSION, PluginRegistry, serveProcessPlugin } from "../src/plugin/index.ts";
import { ProjectConfig, TrackerConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { markdownTracker } from "../src/report/index.ts";
import type { CaseResult } from "../src/result/index.ts";
import { runCases } from "../src/run/index.ts";
import { loadTestProject } from "./support/project.ts";

const SERVED = fileURLToPath(new URL("./fixtures/process-plugins/served.ts", import.meta.url));
const SERVED_ENTRY = { command: [process.execPath, "--no-warnings", SERVED] };
const TOKEN = "fake-served-token-4410";
const OTP = "482913";
const RUN_ID = "20261109-130000-0c2d";

// what the stub server saw, as "<METHOD> <path> <authorization>"
let requests: string[] = [];

function route(req: IncomingMessage, res: ServerResponse): void {
  requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
  const authorized = req.url !== "/otp" || req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ code: OTP }));
}

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

const registries: PluginRegistry[] = [];
const roots: string[] = [];

afterEach(async () => {
  requests = [];
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testCase(id: string, steps: object[], fields: object = {}): object {
  return { id, title: `case ${id}`, stage: "acceptance", risk: "low", targets: ["proc"], steps, ...fields };
}

/** Runs the cases on target proc, whose driver is the served plugin's, in env demo or the production env live. */
async function runServed(cases: readonly object[], env: "demo" | "live" = "demo"): Promise<CaseResult[]> {
  const envFields = { vars: { API_URL: origin }, hosts: ["127.0.0.1"], challenges: { "served-code": ["served-otp"] } };
  const { root, project, registry } = await loadTestProject(
    {
      [BRAND.configFile]: {
        envs: { demo: { production: false, ...envFields }, live: { production: true, ...envFields } },
        secrets: { providers: ["served-secrets"] },
        identities: { shopper: { auth: {} } },
        targets: { proc: { driver: "served" } },
        plugins: [SERVED_ENTRY],
      },
      "cases/shop/served.yaml": { cases },
    },
    [],
  );
  registries.push(registry);
  roots.push(root);
  return runCases({
    project,
    env: project.config.envs[env]!,
    cases: project.cases,
    registry,
    channel: { ask: async () => ({ kind: "timeout" }) },
    runDir: join(root, "runs", RUN_ID),
    runValues: new RunValues(RUN_ID, new Date("2026-11-09T13:00:00Z"), 7),
    seed: 7,
    redactor: new Redactor(defaultRedactionRules()),
    signal: new AbortController().signal,
  });
}

function outcomes(results: readonly CaseResult[]): { caseId: string; status: string; reason: string | undefined }[] {
  return results.map(({ caseId, status, reason }) => ({ caseId, status, reason }));
}

async function servedRegistry(log?: (line: string) => void): Promise<PluginRegistry> {
  const config = ProjectConfig.parse({ envs: {}, plugins: [SERVED_ENTRY] });
  const root = fileURLToPath(new URL(".", import.meta.url));
  const registry = await PluginRegistry.load(config, root, [], log === undefined ? {} : { log });
  registries.push(registry);
  return registry;
}

describe("a served plugin in a run", () => {
  it("answers a challenge with its resolver and runs driver steps that record, attach and save", async () => {
    const [result] = await runServed([
      testCase("SHOP-SERVED-001", [
        {
          challenge: { kind: "served-code", params: { url: "${env.API_URL}/otp" }, fill: { id: "code" } },
          as: "shopper",
        },
        { check: { name: "banner", value: "shown" } },
        { attach: { ext: "txt" } },
        { save: { name: "order", value: "${case.id}-42" } },
        { check: { name: "saved order", value: "${case.order}" } },
      ]),
    ]);

    expect(result).toMatchObject({
      status: "pass",
      challenges: [{ step: 1, kind: "served-code", resolver: "served-otp" }],
      attachments: ["01-served.txt"],
      notes: ["filled [redacted]", "session closed pass"],
    });
    expect(result?.checks.map(({ name, observed }) => [name, observed])).toEqual([
      ["banner", "shown"],
      ["saved order", "SHOP-SERVED-001-42"],
    ]);
    // the resolver read its token through host.secret and sent it through host.http
    expect(requests).toEqual([`GET /otp Bearer ${TOKEN}`]);
  });

  it("blocks, never fails, on a host refusal, a payload its schema refuses and a zip attach; fails on a throw", async () => {
    const results = await runServed([
      testCase("SHOP-AWAY-001", [{ fetch: { url: "http://outside.example.test/x", method: "GET" } }]),
      testCase("SHOP-STRICT-001", [{ strict: { count: 0 } }]),
      testCase("SHOP-ZIP-001", [{ attach: { ext: "zip" } }]),
      testCase("SHOP-THROW-001", [{ fail: {} }]),
    ]);

    expect(outcomes(results)).toEqual([
      {
        caseId: "SHOP-AWAY-001",
        status: "blocked",
        reason: "host outside.example.test is not in the hosts of env demo",
      },
      {
        caseId: "SHOP-STRICT-001",
        status: "blocked",
        reason: "step strict does not match its schema: count must be above 0",
      },
      {
        caseId: "SHOP-ZIP-001",
        status: "blocked",
        reason:
          "internal: plugin served answered driver.step with error -32602: a process plugin cannot attach zip files, which core cannot scrub",
      },
      { caseId: "SHOP-THROW-001", status: "fail", reason: "step 1 (fail): the served step failed on purpose" },
    ]);
    expect(requests).toEqual([]);
  });

  it("sends a production write only from a step that sets write: true", async () => {
    const post = { url: "${env.API_URL}/orders", method: "POST" };
    const results = await runServed(
      [
        testCase("SHOP-POST-001", [{ fetch: post }], { prod_safe: true }),
        testCase("SHOP-POST-002", [{ fetch: { ...post, write: true } }], { prod_safe: true }),
      ],
      "live",
    );

    expect(outcomes(results)).toEqual([
      { caseId: "SHOP-POST-001", status: "blocked", reason: "POST needs write: true in production env live" },
      { caseId: "SHOP-POST-002", status: "pass", reason: undefined },
    ]);
    expect(requests).toEqual(["POST /orders -"]);
  });

  it("refuses a host call made with the context of a step whose call has ended", async () => {
    const [result] = await runServed([testCase("SHOP-STALE-001", [{ keep: {} }, { stale: {} }])]);

    expect(outcomes([result!])).toEqual([
      {
        caseId: "SHOP-STALE-001",
        status: "blocked",
        reason:
          "internal: plugin served answered driver.step with error -32602: host.resolve is not available in this context",
      },
    ]);
  });
});

describe("a served plugin through the registry", () => {
  it("parses a result file with its result format", async () => {
    const registry = await servedRegistry();

    const tests = await registry.resultFormat("served-lines").parse({
      path: "results.txt",
      text: "passed Cart keeps items [SHOP-CART-001]\nfailed Cart empties\n",
    });

    expect(tests.map(({ title, outcome, source }) => ({ title, outcome, source }))).toEqual([
      { title: ["Cart keeps items [SHOP-CART-001]"], outcome: "passed", source: "results.txt" },
      { title: ["Cart empties"], outcome: "failed", source: "results.txt" },
    ]);
  });

  it("loads a secret with its secret provider and connects its tracker client with a host secret", async () => {
    const redactor = new Redactor(defaultRedactionRules());
    // a plugin's log lines go to the registry's log, which masks them
    const lines: string[] = [];
    const registry = await servedRegistry((line) => lines.push(redactor.text(line)));

    expect(await registry.secretProviders(["served-secrets"])[0]!.load("SERVED_TOKEN")).toBe(TOKEN);
    expect(await registry.secretProviders(["served-secrets"])[0]!.load("OTHER")).toBeUndefined();

    const connection = await registry.trackerClient("served").connect({
      config: TrackerConfig.parse({ secrets: { token: "TRACKER_TOKEN" } }),
      secret: async (name) => {
        const value = `fake-${name.toLowerCase()}-7781`;
        redactor.register(value);
        return value;
      },
      redactor,
      signal: new AbortController().signal,
      log: () => {
        throw new Error("the plugin logs through host.log");
      },
    });

    expect(await connection.ticket("TD-1")).toEqual({ key: "TD-1", status: "Open", done: false });
    expect(await connection.postComment("TD-1", { markdown: "passed" }, [])).toEqual({
      url: "https://tracker.example.test/TD-1?chars=6",
    });
    expect(await connection.findOpenBug("TD", "regression")).toBeUndefined();
    expect(lines).toEqual(["plugin served: connected with [redacted]"]);
  });
});

describe("serveProcessPlugin", () => {
  const io = () => ({ input: new PassThrough(), output: new PassThrough() });

  it("refuses to start with a step schema JSON Schema cannot represent, naming the step kind", async () => {
    const manifest = definePlugin({
      name: "dated",
      apiVersion: PLUGIN_API_VERSION,
      drivers: [
        {
          name: "dated",
          surface: "web",
          probe: async () => new Set(),
          launch: async () => ({ capabilities: new Set(), close: async () => {} }),
          steps: [{ kind: "remind", schema: z.strictObject({ at: z.date() }), run: async () => {} }],
        },
      ],
    });

    await expect(serveProcessPlugin(manifest, io())).rejects.toThrow(
      "step remind of driver dated has a schema that JSON Schema cannot represent: Date cannot be represented in JSON Schema",
    );
  });

  const rule: CheckRule = { id: "local-rule", check: () => [] };
  it.each([
    ["checkRules", { checkRules: [rule] }],
    ["trackers", { trackers: [markdownTracker("jira")] }],
    ["authStrategies", { authStrategies: [apiKeyStrategy] }],
  ])("refuses to start with %s, which a process plugin cannot offer", async (key, fields) => {
    const manifest = definePlugin({ name: "refused", apiVersion: PLUGIN_API_VERSION, ...fields });

    await expect(serveProcessPlugin(manifest, io())).rejects.toThrow(
      `plugin refused offers ${key}, which a process plugin cannot offer; load it in-process`,
    );
  });
});
