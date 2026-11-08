import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as standalone from "../../../examples/clients/ts/challenge-client.ts";
import { BRAND } from "../src/brand.ts";
import {
  CHALLENGE_TOKEN_VAR,
  CHALLENGE_URL_VAR,
  ChallengeRequestFailed,
  requestChallenge,
  startChallengeService,
  type ChallengeResolver,
  type ChallengeService,
  type HumanChannel,
} from "../src/challenge/index.ts";
import { guardedHttp } from "../src/driver/index.ts";
import { definePlugin, PLUGIN_API_VERSION, PluginRegistry } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";

const run = promisify(execFile);

const CODE = "135790";
const TOTP = { kind: "totp", caseId: "EXT-TOTP-001", params: { seed: "demo-seed" } };
// a person answers face, and nobody does here, so the service times the request out
const FACE = { kind: "face", caseId: "EXT-FACE-001" };
const LOOPBACK_ONLY = "the challenge service URL must be a loopback http URL";
const WRONG_TOKEN = "challenge service answered 401: missing or wrong bearer token";
const TIMED_OUT = "challenge service answered 504: no answer within 1 s";
const PYTHON_DIR = resolve(import.meta.dirname, "../../../examples/clients/python");

const fakeTotp: ChallengeResolver = {
  name: "fake-totp",
  kinds: ["totp"],
  requires: [],
  automated: true,
  async resolve() {
    return { kind: "value", value: CODE };
  },
};

const absent: HumanChannel = {
  ask: (_prompt, signal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
};

/** A proxy that answers every request itself, so a request that reaches it never reaches the service. */
interface Recorder {
  url: string;
  requests: string[];
  connections: number;
}

let service: ChallengeService;
let recorder: Recorder;
let closeRecorder: () => Promise<void>;
let python = false;

beforeAll(async () => {
  const config = ProjectConfig.parse({
    envs: { demo: { production: false, hosts: ["127.0.0.1"], challenges: { totp: ["fake-totp"], face: ["human"] } } },
  });
  const plugin = definePlugin({ name: "fake", apiVersion: PLUGIN_API_VERSION, resolvers: [fakeTotp] });
  const registry = await PluginRegistry.load(config, tmpdir(), [plugin]);
  const env = config.envs["demo"]!;
  const redactor = new Redactor(defaultRedactionRules());
  service = await startChallengeService({
    env,
    registry,
    channel: absent,
    http: guardedHttp({ env, redactor, log: () => {} }),
    stateDir: join(tmpdir(), "challenge-client-test-state"),
    secrets: async (key) => {
      throw new Error(`no secret ${key}`);
    },
    redactor,
    runId: "20261108-101500-c3d4",
    timeoutMs: 200,
  });

  const server = createServer((req, res) => {
    recorder.requests.push(`${req.method} ${req.url}`);
    res.end("proxied");
  });
  server.on("connection", () => (recorder.connections += 1));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  recorder = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], connections: 0 };
  closeRecorder = () => new Promise((done) => server.close(() => done()));

  python = await run("python3", ["--version"]).then(
    () => true,
    () => false,
  );
});

afterAll(async () => {
  await service.close();
  await closeRecorder();
});

beforeEach(() => {
  recorder.requests = [];
  recorder.connections = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The environment a suite gets under the service, with no proxy settings inherited from this one. */
function suiteEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(name),
    ),
  );
  return { ...env, [CHALLENGE_URL_VAR]: service.url.href, [CHALLENGE_TOKEN_VAR]: service.token, ...overrides };
}

/** Where a global-agent request goes: the recorder when the proxy is live, the service's 401 otherwise. */
function controlUrl(): string {
  return new URL("/control", service.url).href;
}

const tsClients = [
  {
    name: "requestChallenge",
    requestChallenge,
    Failed: ChallengeRequestFailed,
    file: resolve(import.meta.dirname, "../src/challenge/client.ts"),
  },
  {
    name: "the standalone client",
    requestChallenge: standalone.requestChallenge,
    Failed: standalone.ChallengeRequestFailed,
    file: resolve(import.meta.dirname, "../../../examples/clients/ts/challenge-client.ts"),
  },
];

// first a request through the global agent, which goes through HTTP_PROXY, then one through the client
const TS_CHILD = `
import { request } from "node:http";
const [file, controlUrl] = process.argv.slice(1);
const { requestChallenge } = await import(file);
const control = await new Promise((done, fail) => {
  request(controlUrl, (res) => { res.resume(); done(res.statusCode); }).on("error", fail).end();
});
const answer = await requestChallenge({ kind: "totp", caseId: "EXT-TOTP-001", params: { seed: "demo-seed" } });
process.stdout.write(JSON.stringify({ control, answer }));
`;

describe.each(tsClients)("$name", (client) => {
  const options = (): { url: string; token: string } => ({ url: service.url.href, token: service.token });

  it("gets a TOTP code", async () => {
    expect(await client.requestChallenge(TOTP, options())).toEqual({ value: CODE });
  });

  it("raises with status 401 for a wrong token", async () => {
    const error: unknown = await client.requestChallenge(TOTP, { ...options(), token: "wrong" }).catch((e) => e);
    expect(error).toBeInstanceOf(client.Failed);
    expect(error).toMatchObject({ status: 401, message: WRONG_TOKEN });
  });

  it("raises with status 504 when the service times the request out", async () => {
    const error: unknown = await client.requestChallenge(FACE, options()).catch((e) => e);
    expect(error).toBeInstanceOf(client.Failed);
    expect(error).toMatchObject({ status: 504, message: TIMED_OUT });
  });

  it("refuses a URL that is not loopback http before sending", async () => {
    const https = new URL("/challenge", recorder.url.replace("http:", "https:")).href;
    await expect(client.requestChallenge(TOTP, { url: https, token: service.token })).rejects.toThrow(LOOPBACK_ONLY);
    await expect(
      client.requestChallenge(TOTP, { url: "http://example.test/challenge", token: service.token }),
    ).rejects.toThrow(LOOPBACK_ONLY);
    expect(recorder.connections).toBe(0);
  });

  it("names the command to run under when the variables are missing", async () => {
    vi.stubEnv(CHALLENGE_URL_VAR, "");
    await expect(client.requestChallenge(TOTP, { token: service.token })).rejects.toThrow(
      `run this test under \`${BRAND.name} exec\` or a runner target`,
    );
  });

  it("stops waiting at the caller's timeoutMs", async () => {
    const error: unknown = await client.requestChallenge(FACE, { ...options(), timeoutMs: 50 }).catch((e) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  it("reaches the service directly with HTTP_PROXY set", async () => {
    const { stdout } = await run(
      process.execPath,
      ["--input-type=module", "-e", TS_CHILD, pathToFileURL(client.file).href, controlUrl()],
      { env: suiteEnv({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: recorder.url }) },
    );
    expect(JSON.parse(stdout)).toEqual({ control: 200, answer: { value: CODE } });
    expect(recorder.requests).toEqual([`GET ${controlUrl()}`]);
  });
});

const PYTHON_CHILD = `
import json, sys, urllib.request
sys.path.insert(0, sys.argv[1])
from challenge_client import ChallengeRequestFailed, request_challenge
request = json.loads(sys.argv[2])
out = {}
if len(sys.argv) > 3:
    with urllib.request.urlopen(sys.argv[3]) as response:
        out["control"] = response.status
try:
    out["answer"] = request_challenge(request["kind"], request["caseId"], request.get("params"))
except ChallengeRequestFailed as error:
    out["failed"] = {"status": error.status, "message": str(error)}
except Exception as error:
    out["error"] = str(error)
print(json.dumps(out))
`;

async function askPython(
  request: { kind: string; caseId: string; params?: Record<string, string> },
  env: NodeJS.ProcessEnv,
  control?: string,
): Promise<unknown> {
  // -B keeps __pycache__ out of examples/
  const args = [
    "-B",
    "-c",
    PYTHON_CHILD,
    PYTHON_DIR,
    JSON.stringify(request),
    ...(control === undefined ? [] : [control]),
  ];
  const { stdout } = await run("python3", args, { env });
  return JSON.parse(stdout);
}

describe("the Python client", () => {
  it("gets a TOTP code", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    expect(await askPython(TOTP, suiteEnv())).toEqual({ answer: { value: CODE } });
  });

  it("raises with status 401 for a wrong token", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    const env = suiteEnv({ [CHALLENGE_TOKEN_VAR]: "wrong" });
    expect(await askPython(TOTP, env)).toEqual({ failed: { status: 401, message: WRONG_TOKEN } });
  });

  it("raises with status 504 when the service times the request out", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    expect(await askPython(FACE, suiteEnv())).toEqual({ failed: { status: 504, message: TIMED_OUT } });
  });

  it("refuses a URL that is not loopback http before sending", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    const https = new URL("/challenge", recorder.url.replace("http:", "https:")).href;
    for (const url of [https, "http://example.test/challenge"]) {
      expect(await askPython(TOTP, suiteEnv({ [CHALLENGE_URL_VAR]: url }))).toEqual({ error: LOOPBACK_ONLY });
    }
    expect(recorder.connections).toBe(0);
  });

  it("does not follow a redirect off the service URL", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    const location = new URL("/challenge", recorder.url).href;
    const redirect = createServer((_req, res) => res.writeHead(302, { location }).end());
    redirect.listen(0, "127.0.0.1");
    await once(redirect, "listening");
    try {
      const url = `http://127.0.0.1:${(redirect.address() as AddressInfo).port}/challenge`;
      const out = await askPython(TOTP, suiteEnv({ [CHALLENGE_URL_VAR]: url }));
      expect(out).toMatchObject({ failed: { status: 302 } });
      expect(recorder.connections).toBe(0);
    } finally {
      await new Promise((done) => redirect.close(done));
    }
  });

  it("reaches the service directly with HTTP_PROXY set", async (ctx) => {
    if (!python) ctx.skip("python3 is not installed");
    const env = suiteEnv({ HTTP_PROXY: recorder.url, http_proxy: recorder.url });
    expect(await askPython(TOTP, env, controlUrl())).toEqual({ control: 200, answer: { value: CODE } });
    expect(recorder.requests).toEqual([`GET ${controlUrl()}`]);
  });
});
