import { mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  answersFileChannel,
  oneAtATime,
  startChallengeService,
  terminalChannel,
  type ChallengeResolver,
  type ChallengeService,
  type HumanChannel,
  type PersonAnswer,
  type PersonPrompt,
} from "../src/challenge/index.ts";
import { guardedHttp } from "../src/driver/index.ts";
import { definePlugin, PLUGIN_API_VERSION, PluginRegistry } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";

const RUN_ID = "20261107-093000-a1b2";
const CODE = "424242";
const SECRET = "not-a-real-mailbox-password";
const BODY_LIMIT = 16 * 1024;

interface Calls {
  armed: number;
  resolved: number;
}

/** Answers otp-email with a fixed code, and fails otp-sms naming a registered secret. */
function fakeOtp(calls: Calls): ChallengeResolver {
  return {
    name: "fake-otp",
    kinds: ["otp-email", "otp-sms"],
    requires: [],
    automated: true,
    async arm() {
      calls.armed += 1;
    },
    async resolve(request) {
      calls.resolved += 1;
      if (request.kind === "otp-sms") throw new Error(`the SMS inbox refused ${SECRET}`);
      return { kind: "value", value: CODE };
    },
  };
}

/** Misses every challenge after `SLOW_MISS_MS`, as otp-mailpit does at its timeoutSeconds. */
const SLOW_MISS_MS = 400;
const slowMiss: ChallengeResolver = {
  name: "slow-miss",
  kinds: ["biometric"],
  requires: [],
  automated: true,
  async resolve(_request, ctx) {
    await sleep(SLOW_MISS_MS, undefined, { signal: ctx.signal });
    return undefined;
  },
};

/**
 * Answers each prompt from `answers` in turn, `afterMs` after it was asked. It waits until the request
 * gives up for an undefined entry or when none is left.
 */
function personAt(
  answers: (PersonAnswer | undefined)[] = [],
  afterMs = 0,
): HumanChannel & { prompts: PersonPrompt[]; signals: AbortSignal[] } {
  const prompts: PersonPrompt[] = [];
  const signals: AbortSignal[] = [];
  return {
    prompts,
    signals,
    async ask(prompt, signal) {
      prompts.push(prompt);
      signals.push(signal);
      const answer = answers.shift();
      if (answer !== undefined) return sleep(afterMs, answer, { signal });
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  };
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 3_000) throw new Error("the condition never held");
    await sleep(10);
  }
}

interface Started {
  service: ChallengeService;
  calls: Calls;
  redactor: Redactor;
  logged: string[];
}

const services: ChallengeService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function start(
  options: { channel?: HumanChannel; humanOnly?: string[]; timeoutMs?: number } = {},
): Promise<Started> {
  const calls: Calls = { armed: 0, resolved: 0 };
  const config = ProjectConfig.parse({
    envs: {
      demo: {
        production: false,
        hosts: ["127.0.0.1"],
        challenges: {
          "otp-email": ["fake-otp"],
          "otp-sms": ["fake-otp"],
          totp: ["human"],
          pin: ["fake-otp"],
          biometric: ["slow-miss", "human"],
        },
      },
    },
    challenges: { humanOnly: options.humanOnly ?? [] },
  });
  const plugin = definePlugin({
    name: "fake",
    apiVersion: PLUGIN_API_VERSION,
    resolvers: [fakeOtp(calls), slowMiss],
  });
  const registry = await PluginRegistry.load(config, tmpdir(), [plugin]);
  const env = config.envs["demo"]!;
  const redactor = new Redactor(defaultRedactionRules());
  redactor.register(SECRET);
  const logged: string[] = [];
  const service = await startChallengeService({
    env,
    registry,
    channel: options.channel ?? personAt(),
    http: guardedHttp({ env, redactor, log: () => {} }),
    stateDir: join(tmpdir(), "service-test-state"),
    secrets: async (key) => {
      throw new Error(`no secret ${key}`);
    },
    redactor,
    runId: RUN_ID,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    log: (line) => logged.push(line),
  });
  services.push(service);
  return { service, calls, redactor, logged };
}

async function post(
  service: ChallengeService,
  body: unknown,
  authorization = `Bearer ${service.token}`,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(service.url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** Sends the body in chunks with no content-length, so the service counts the bytes as they arrive. */
function postChunked(service: ChallengeService, chunks: readonly string[]): Promise<number> {
  return new Promise((done, fail) => {
    const req = request(service.url, {
      method: "POST",
      headers: { authorization: `Bearer ${service.token}`, "transfer-encoding": "chunked" },
    });
    req.on("response", (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    req.on("error", fail);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

const otpEmail = {
  kind: "otp-email",
  caseId: "EXT-OTP-001",
  params: { recipient: "ops@example.test" },
};

describe("startChallengeService", () => {
  it("binds 127.0.0.1", async () => {
    const { service } = await start();
    expect(service.url.hostname).toBe("127.0.0.1");
    expect(service.url.pathname).toBe("/challenge");
    expect(Number(service.url.port)).toBeGreaterThan(0);
    expect((await post(service, otpEmail)).status).toBe(200);
    // the IPv6 loopback is another address, where nothing listens
    await expect(
      fetch(`http://[::1]:${service.url.port}/challenge`, { method: "POST" }),
    ).rejects.toThrow();
    // so is this machine's own network address, which a bind to every interface would answer on
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((info) => info?.family === "IPv4" && !info.internal);
    if (lan !== undefined) {
      const offHost = `http://${lan.address}:${service.url.port}/challenge`;
      await expect(
        fetch(offHost, { method: "POST", signal: AbortSignal.timeout(2_000) }),
      ).rejects.toThrow();
    }
  });

  it("answers with the chain's value, registers it and never arms a resolver", async () => {
    const { service, calls, redactor } = await start();
    expect(service.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await post(service, otpEmail)).toEqual({ status: 200, json: { value: CODE } });
    expect(calls).toEqual({ armed: 0, resolved: 1 });
    expect(redactor.text(`code ${CODE}, token ${service.token}`)).toBe(
      "code [redacted], token [redacted]",
    );
  });

  it("401 on a bad token", async () => {
    const { service, calls } = await start();
    const wrong = "0".repeat(service.token.length);
    for (const authorization of ["", `Bearer ${wrong}`, "Bearer short", `Basic ${service.token}`]) {
      const reply = await post(service, otpEmail, authorization);
      expect(reply.status, authorization).toBe(401);
      expect(reply.json).toEqual({ error: "missing or wrong bearer token" });
    }
    expect(calls.resolved).toBe(0);
  });

  it("400 on an unknown kind", async () => {
    const { service, calls } = await start();
    const reply = await post(service, { kind: "retina", caseId: "EXT-RET-001" });
    expect(reply.status).toBe(400);
    expect(reply.json["error"]).toContain('unknown challenge kind "retina"');
    expect(calls.resolved).toBe(0);
  });

  it("400 on a body that is not a request, 404 off the endpoint and 405 for another method", async () => {
    const { service, calls } = await start();
    expect((await post(service, "{not json")).status).toBe(400);
    expect((await post(service, { kind: "otp-email" })).status).toBe(400);
    expect((await post(service, { ...otpEmail, caseId: "../EXT-OTP-001" })).status).toBe(400);
    expect((await post(service, { ...otpEmail, extra: true })).status).toBe(400);
    const headers = { authorization: `Bearer ${service.token}` };
    expect((await fetch(new URL("/other", service.url), { method: "POST", headers })).status).toBe(
      404,
    );
    expect((await fetch(service.url, { headers })).status).toBe(405);
    expect(calls.resolved).toBe(0);
  });

  it("504 on timeout", async () => {
    const waiting = await start({ channel: personAt(), timeoutMs: 200 });
    const started = Date.now();
    const reply = await post(waiting.service, { kind: "totp", caseId: "EXT-TOTP-001" });
    expect(reply).toEqual({ status: 504, json: { error: "no answer within 1 s" } });
    expect(Date.now() - started).toBeLessThan(5_000);

    // the channel's own timeout, which humanResolver reports only as text
    const timedOut = await start({ channel: personAt([{ kind: "timeout" }]) });
    expect((await post(timedOut.service, { kind: "totp", caseId: "EXT-TOTP-001" })).status).toBe(
      504,
    );
  });

  it("16 KiB body limit", async () => {
    const { service } = await start();
    const padded = (size: number): string => {
      const body = JSON.stringify({ ...otpEmail, params: { pad: "" } });
      return JSON.stringify({ ...otpEmail, params: { pad: "x".repeat(size - body.length) } });
    };
    expect(Buffer.byteLength(padded(BODY_LIMIT))).toBe(BODY_LIMIT);
    expect((await post(service, padded(BODY_LIMIT))).status).toBe(200);
    expect(await post(service, padded(BODY_LIMIT + 1))).toEqual({
      status: 413,
      json: { error: "the body is over 16384 bytes" },
    });
    const chunk = "x".repeat(4096);
    expect(await postChunked(service, [chunk, chunk, chunk, chunk, "x"])).toBe(413);
  });

  it("service returns done only for a kind config lists as human-only", async () => {
    const channel = personAt([{ kind: "value", value: "135790" }, { kind: "done" }]);
    const { service } = await start({ channel, humanOnly: ["totp"] });
    const totp = { kind: "totp", caseId: "EXT-TOTP-001" };
    const refused = await post(service, totp);
    expect(refused.status).toBe(502);
    expect(refused.json["error"]).toContain(
      "the person sent a value, but this challenge only takes done",
    );
    expect(JSON.stringify(refused.json)).not.toContain("135790");
    expect(await post(service, totp)).toEqual({ status: 200, json: { done: true } });
    expect(channel.prompts.map((prompt) => prompt.ask)).toEqual(["action", "action"]);
  });

  it("fills the prompt as the runner does, with identity tester and step 1 by default, masked", async () => {
    const channel = personAt([
      { kind: "value", value: "246810" },
      { kind: "value", value: "246811" },
    ]);
    const { service } = await start({ channel, timeoutMs: 60_000 });
    expect(await post(service, { kind: "totp", caseId: "EXT-TOTP-001" })).toEqual({
      status: 200,
      json: { value: "246810" },
    });
    expect(channel.prompts[0]).toMatchObject({
      id: "EXT-TOTP-001-1-totp",
      runId: RUN_ID,
      caseId: "EXT-TOTP-001",
      ask: "value",
      timeoutMs: 60_000,
      steps: ["Get the totp code for tester.", "Answer with the code."],
    });
    expect(channel.prompts[0]).not.toHaveProperty("screenshot");

    await post(service, { kind: "totp", caseId: "EXT-TOTP-001", identity: SECRET, step: 3 });
    expect(channel.prompts[1]).toMatchObject({
      id: "EXT-TOTP-001-3-totp",
      steps: ["Get the totp code for [redacted].", "Answer with the code."],
    });
  });

  it("502 with a masked reason when the chain gives no answer or the env has none", async () => {
    const { service } = await start();
    const failed = await post(service, { kind: "otp-sms", caseId: "EXT-SMS-001" });
    expect(failed).toEqual({
      status: 502,
      json: { error: 'resolver "fake-otp" failed: the SMS inbox refused [redacted]' },
    });
    const none = await post(service, { kind: "face", caseId: "EXT-FACE-001" });
    expect(none).toEqual({
      status: 502,
      json: { error: "env demo has no resolver chain for challenge face" },
    });
  });

  it("500 when the env chain names a resolver that does not answer the kind", async () => {
    const { service } = await start();
    const reply = await post(service, { kind: "pin", caseId: "EXT-PIN-001" });
    expect(reply.status).toBe(500);
    expect(reply.json["error"]).toContain('lists resolver "fake-otp" for challenge pin');
  });

  it("close cancels a request that waits on a person and stops listening", async () => {
    const channel = personAt();
    const { service, logged } = await start({ channel });
    const waiting = post(service, { kind: "totp", caseId: "EXT-TOTP-001" });
    await until(() => channel.prompts.length > 0);
    const started = Date.now();
    await service.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(waiting).rejects.toThrow();
    expect(channel.signals[0]?.aborted).toBe(true);
    await until(() => logged.length > 0);
    expect(logged).toEqual(["challenge request answered 503: the challenge service is stopping"]);
    await expect(post(service, otpEmail)).rejects.toThrow();
  });

  it("takes the prompt away from the person when the caller hangs up, and asks the next one", async () => {
    const channel = personAt([undefined, { kind: "value", value: "135790" }]);
    const { service, logged } = await start({ channel, timeoutMs: 60_000 });
    const hangUp = new AbortController();
    const abandoned = fetch(service.url, {
      method: "POST",
      headers: { authorization: `Bearer ${service.token}` },
      body: JSON.stringify({ kind: "totp", caseId: "EXT-TOTP-001" }),
      signal: hangUp.signal,
    });
    await until(() => channel.prompts.length > 0);
    hangUp.abort();
    await expect(abandoned).rejects.toThrow();
    await until(() => channel.signals[0]?.aborted === true);
    expect(await post(service, { kind: "totp", caseId: "EXT-TOTP-002" })).toEqual({
      status: 200,
      json: { value: "135790" },
    });
    expect(logged).toContain("challenge request answered 499: the caller hung up");
  });

  it("shows the person one prompt at a time, so each typed answer reaches its own request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk: Buffer) => {
      shown += chunk.toString("utf8");
    });
    const { service } = await start({
      channel: terminalChannel({ input, output }),
      timeoutMs: 3_000,
    });
    const first = post(service, { kind: "totp", caseId: "EXT-TOTP-001" });
    await until(() => shown.includes("EXT-TOTP-001"));
    const second = post(service, { kind: "totp", caseId: "EXT-TOTP-002" });
    await sleep(200);
    expect(shown).not.toContain("EXT-TOTP-002");

    input.write("111111\n");
    expect(await first).toEqual({ status: 200, json: { value: "111111" } });
    await until(() => shown.includes("EXT-TOTP-002"));
    input.write("222222\n");
    expect(await second).toEqual({ status: 200, json: { value: "222222" } });
    input.end();
  });

  it("asks a second request with the same prompt id once the first is answered", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "service-test-run-"));
    const { service } = await start({
      channel: answersFileChannel(runDir, { pollMs: 20 }),
      timeoutMs: 3_000,
    });
    const id = "EXT-TOTP-001-1-totp";
    const pending = async (): Promise<boolean> =>
      (await readdir(join(runDir, "prompts")).catch((): string[] => [])).includes(`${id}.json`);
    const answer = async (value: string): Promise<void> => {
      const file = join(runDir, "answers", `${id}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify({ kind: "value", value }));
      await rename(`${file}.tmp`, file);
    };
    const totp = { kind: "totp", caseId: "EXT-TOTP-001" };
    const replies = [post(service, totp), post(service, totp)];

    await until(pending);
    await answer("111111");
    // the answered prompt has moved to done/ by the time its reply arrives
    await Promise.race(replies);
    await until(pending);
    await answer("222222");
    const values = (await Promise.all(replies)).map((reply) => reply.json["value"]);
    expect(new Set(values)).toEqual(new Set(["111111", "222222"]));
  });

  it("queues its prompts behind the other asks of a channel already queued with oneAtATime", async () => {
    const channel = personAt([{ kind: "done" }, { kind: "value", value: "135790" }], 200);
    const queued = oneAtATime(channel);
    const { service } = await start({ channel: queued, timeoutMs: 300 });
    const guided: PersonPrompt = {
      id: "WEB-ORDER-001-2-guided",
      runId: RUN_ID,
      caseId: "WEB-ORDER-001",
      ask: "action",
      title: "Confirm the order in the app",
      steps: ["Tap confirm."],
      timeoutMs: 1_000,
    };
    const asked = queued.ask(guided, new AbortController().signal);

    // the service's prompt is shown once the guided one is answered, and only then gets its 300 ms
    expect(await post(service, { kind: "totp", caseId: "EXT-TOTP-001" })).toEqual({
      status: 200,
      json: { value: "135790" },
    });
    expect(await asked).toEqual({ kind: "done" });
    expect(channel.prompts.map((prompt) => prompt.id)).toEqual([guided.id, "EXT-TOTP-001-1-totp"]);
  });

  it("gives the person the prompt's whole window from when it is shown, after a slow automated miss", async () => {
    const channel = personAt([{ kind: "done" }], 200);
    const { service } = await start({ channel, timeoutMs: 300 });
    const started = Date.now();
    expect(await post(service, { kind: "biometric", caseId: "EXT-BIO-001" })).toEqual({
      status: 200,
      json: { done: true },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_MISS_MS + 200);
    expect(channel.prompts[0]).toMatchObject({ ask: "action", timeoutMs: 300 });
  });
});
