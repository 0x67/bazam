import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { builtinKinds, type ResolverContext } from "../src/challenge/index.ts";
import { guardedHttp } from "../src/driver/index.ts";
import { EnvsConfig } from "../src/env/index.ts";
import { PluginRegistry } from "../src/plugin/index.ts";
import { METHODS } from "../src/plugin/protocol.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import { CaseBlocked } from "../src/run/outcome.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const PROTOCOL_DOC = fileURLToPath(new URL("../../../docs/plugin-protocol.md", import.meta.url));
const RECIPIENT = "hook@example.test";
const CODE = "246810";
const python = spawnSync("python3", ["--version"]).status === 0;

const demo = EnvsConfig.parse({ demo: { production: false, hosts: ["127.0.0.1"] } })["demo"]!;
const otpSms = builtinKinds.find((spec) => spec.name === "otp-sms")!;

const registries: PluginRegistry[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

/** Serves the demo's `/test/otp` hook on 127.0.0.1: a code for `RECIPIENT`, 404 for anyone else. */
async function otpHook(): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/test/otp" && url.searchParams.get("recipient") === RECIPIENT) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: CODE }));
    } else {
      res.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function context(): ResolverContext {
  return {
    env: demo,
    http: guardedHttp({ env: demo, redactor: new Redactor(defaultRedactionRules()), log: () => {} }),
    channel: {
      ask: async () => {
        throw new Error("no person in this test");
      },
    },
    prompt: { runId: "20261109-120000-0a1b", timeoutMs: 1000 },
    stateDir: EXAMPLES,
    secrets: async (key) => {
      throw new Error(`no secret ${key} in this test`);
    },
    now: () => new Date(),
    signal: new AbortController().signal,
  };
}

/** Loads one example as the only plugin entry and asks its resolver for a waiting code and a missing one. */
async function answers(entry: string | { command: string[] }) {
  const registry = await PluginRegistry.load(ProjectConfig.parse({ envs: {}, plugins: [entry] }), EXAMPLES, []);
  registries.push(registry);
  const origin = await otpHook();
  const resolver = registry.resolver("demo-otp-hook");
  const ask = (recipient: string) =>
    resolver.resolve(
      {
        kind: "otp-sms",
        caseId: "AUTH-SMS-001",
        identity: "customer",
        step: 1,
        params: { url: `${origin}/test/otp?recipient=${recipient}` },
      },
      context(),
      otpSms,
    );
  return { waiting: await ask(RECIPIENT), missing: await ask("nobody@example.test") };
}

/**
 * Loads one example and asks its resolver for a hook outside the env's hosts. A plugin that passes the host's
 * `-32001` through ends in `CaseBlocked`; one that answers `-32603` keeps the message but not the class.
 */
async function refusal(entry: { command: string[] }) {
  const registry = await PluginRegistry.load(ProjectConfig.parse({ envs: {}, plugins: [entry] }), EXAMPLES, []);
  registries.push(registry);
  return registry.resolver("demo-otp-hook").resolve(
    {
      kind: "otp-sms",
      caseId: "AUTH-SMS-001",
      identity: "customer",
      step: 1,
      params: { url: "http://outside.example.test/test/otp?recipient=x" },
    },
    context(),
    otpSms,
  );
}

const EXPECTED = { waiting: { kind: "value", value: CODE }, missing: undefined };
const REFUSED = "is not in the hosts of env demo";

describe("plugin examples", () => {
  it("answers from the hook with the TypeScript example loaded in-process", async () => {
    expect(await answers("./plugins/ts-resolver/manifest.ts")).toEqual(EXPECTED);
  });

  it("answers from the hook with the TypeScript example as a process", async () => {
    const entry = { command: [process.execPath, "--conditions=development", "plugins/ts-resolver/plugin.ts"] };

    expect(await answers(entry)).toEqual(EXPECTED);
    const refused = refusal(entry);
    await expect(refused).rejects.toThrow(CaseBlocked);
    await expect(refused).rejects.toThrow(REFUSED);
  });

  it("answers from the hook with the Python example as a process", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    const entry = { command: ["python3", "plugins/python-resolver/plugin.py"] };

    expect(await answers(entry)).toEqual(EXPECTED);
    const refused = refusal(entry);
    await expect(refused).rejects.toThrow(CaseBlocked);
    await expect(refused).rejects.toThrow(REFUSED);
  });

  it("names every protocol method in the protocol document", async () => {
    const doc = await readFile(PROTOCOL_DOC, "utf8");

    expect(Object.keys(METHODS).filter((method) => !doc.includes(`\`${method}\``))).toEqual([]);
  });
});
