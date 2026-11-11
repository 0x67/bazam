import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import {
  resolveChallenge,
  type ChallengeResolver,
  type ResolverContext,
} from "../src/challenge/index.ts";
import { RunValues, type Environment } from "../src/env/index.ts";
import {
  PluginCallFailed,
  PluginCallTimedOut,
  PluginProcessExited,
} from "../src/plugin/process.ts";
import {
  definePlugin,
  PLUGIN_API_VERSION,
  PluginApiMismatch,
  PluginConflict,
  PluginRegistry,
  type PluginManifest,
} from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import type { CaseResult } from "../src/result/index.ts";
import { runCases } from "../src/run/index.ts";
import { loadTestProject } from "./support/project.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/process-plugins/", import.meta.url));
const RAW_SECRET = "fake-raw-secret-5521";

const registries: PluginRegistry[] = [];
const folders: string[] = [];
// pid files of processes that close leaves running on purpose; killed first, so a close that hangs ends too
const leftovers: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  delete process.env["RAW_SECRET"];
  await Promise.all(leftovers.splice(0).map(killLeftover));
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

/** An object `plugins:` entry that runs a fixture with this Node, quiet so stderr holds only what the plugin writes. */
function fixture(
  script: "raw" | "served",
  fields: { args?: string[]; [key: string]: unknown } = {},
) {
  const { args = [], ...rest } = fields;
  return {
    command: [process.execPath, "--no-warnings", join(FIXTURES, `${script}.ts`), ...args],
    ...rest,
  };
}

function config(fields: object): ProjectConfig {
  return ProjectConfig.parse({ envs: {}, ...fields });
}

async function load(
  fields: object,
  defaults: readonly PluginManifest[] = [],
  options: { log?(line: string): void; redactor?: Redactor } = {},
): Promise<PluginRegistry> {
  const registry = await PluginRegistry.load(config(fields), FIXTURES, defaults, options);
  registries.push(registry);
  return registry;
}

async function loadFailure(
  fields: object,
  defaults: readonly PluginManifest[] = [],
  options: { log?(line: string): void } = {},
): Promise<Error> {
  return PluginRegistry.load(config(fields), FIXTURES, defaults, options).then(
    () => {
      throw new Error("the load did not fail");
    },
    (error: unknown) => error as Error,
  );
}

async function pidFile(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "process-plugin-"));
  folders.push(folder);
  return join(folder, "pid");
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killLeftover(file: string): Promise<void> {
  const pid = Number(await readFile(file, "utf8").catch(() => "0"));
  if (pid > 0 && running(pid)) process.kill(pid, "SIGKILL");
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 200) throw new Error("condition never held");
    await sleep(10);
  }
}

describe("startProcessPlugin through PluginRegistry.load", () => {
  it("registers what the plugin offers, whose calls go to its process", async () => {
    const registry = await load({ plugins: [fixture("raw")] });

    await expect(registry.secretProviders(["raw-secrets"])[0]!.load("ANY")).resolves.toBe(
      "raw-value",
    );
  });

  it.each(["version", "version-shape"])(
    "refuses a plugin that speaks another protocol version (%s)",
    async (mode) => {
      const failure = await loadFailure({ plugins: [fixture("raw", { args: [mode] })] });

      expect(failure.message).toBe(
        "plugin raw speaks protocol version 2; this host speaks version 1",
      );
    },
  );

  it("names the field of an initialize answer that does not match the protocol", async () => {
    const failure = await loadFailure({ plugins: [fixture("raw", { args: ["shape"] })] });

    expect(failure).toBeInstanceOf(PluginCallFailed);
    expect(failure.message).toMatch(
      /^plugin .+raw\.ts shape answered initialize with a result that does not match the protocol: contributions\.secretProviders\.0: /,
    );
  });

  it("applies the plugin API version check of an in-process plugin", async () => {
    const failure = await loadFailure({ plugins: [fixture("raw", { args: ["api"] })] });

    expect(failure).toBeInstanceOf(PluginApiMismatch);
  });

  it("refuses a contribution that an in-process plugin already registered, and ends the process", async () => {
    const pid = await pidFile();
    const inProcess = definePlugin({
      name: "local-secrets",
      apiVersion: PLUGIN_API_VERSION,
      secretProviders: [{ name: "raw-secrets", load: async () => undefined }],
    });

    const failure = await loadFailure(
      { plugins: [fixture("raw", { env: { RAW_PID_FILE: pid } })] },
      [inProcess],
    );

    expect(failure).toBeInstanceOf(PluginConflict);
    expect(failure.message).toBe(
      'secret provider "raw-secrets" comes from both plugin "local-secrets" and plugin "raw"',
    );
    expect(running(Number(await readFile(pid, "utf8")))).toBe(false);
  });

  it("fails the load with the masked stderr tail of a plugin that exits before it answers initialize", async () => {
    process.env["RAW_SECRET"] = RAW_SECRET;

    const failure = await loadFailure({
      secrets: { names: ["RAW_SECRET"] },
      plugins: [fixture("raw", { args: ["early-exit"] })],
    });

    expect(failure).toBeInstanceOf(PluginProcessExited);
    expect(failure.message).toMatch(
      /^plugin .+raw\.ts early-exit exited with code 3; its last stderr lines:\nstarting with \[redacted\]\nno config found$/,
    );
  });

  it("fails the load with the masked stderr tail of a plugin that does not answer initialize within 30 s", async () => {
    process.env["RAW_SECRET"] = RAW_SECRET;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lines: string[] = [];

    const loading = loadFailure(
      { secrets: { names: ["RAW_SECRET"] }, plugins: [fixture("raw", { args: ["mute"] })] },
      [],
      { log: (line) => lines.push(line) },
    );
    await waitFor(() => lines.length > 0);
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = await loading;

    expect(failure).toBeInstanceOf(PluginCallTimedOut);
    expect(failure.message).toMatch(
      /^plugin .+raw\.ts mute did not answer initialize within 30 s; its last stderr lines:\nwaiting with \[redacted\]\ncancelled request 1$/,
    );
  });

  it("names the command that cannot start", async () => {
    const failure = await loadFailure({
      plugins: [{ command: ["no-such-plugin-command", "--serve"] }],
    });

    expect(failure.message).toBe(
      "plugin no-such-plugin-command --serve could not start: spawn no-such-plugin-command ENOENT",
    );
  });

  it("refuses a type a process plugin cannot offer, naming it", async () => {
    const failure = await loadFailure({ plugins: [fixture("raw", { args: ["refused"] })] });

    expect(failure.message).toBe(
      "plugin raw offers authStrategies, which a process plugin cannot offer; load it in-process",
    );
  });

  it("refuses a step schema that cannot be read, naming the step kind", async () => {
    const failure = await loadFailure({ plugins: [fixture("raw", { args: ["bad-schema"] })] });

    expect(failure.message).toBe(
      "plugin raw gives step odd a schema that cannot be read: Unsupported type: weird",
    );
  });

  it("passes stderr and host.log lines to the caller's log, with inherited secret values registered first", async () => {
    process.env["RAW_SECRET"] = RAW_SECRET;
    const redactor = new Redactor(defaultRedactionRules());
    const lines: string[] = [];
    const registry = await load(
      { secrets: { names: ["RAW_SECRET"] }, plugins: [fixture("raw")] },
      [],
      {
        log: (line) => lines.push(redactor.text(line)),
        redactor,
      },
    );

    await registry.secretProviders(["raw-secrets"])[0]!.load("ANY");
    await waitFor(() => lines.length >= 2);

    expect(lines.toSorted()).toEqual([
      "plugin raw: loading with [redacted]",
      "plugin raw: log [redacted]",
    ]);
  });

  it("refuses a result that does not match the protocol", async () => {
    const registry = await load({ plugins: [fixture("raw", { args: ["bad-result"] })] });

    const failure = registry.secretProviders(["raw-secrets"])[0]!.load("ANY");

    await expect(failure).rejects.toBeInstanceOf(PluginCallFailed);
    await expect(failure).rejects.toThrow(
      /^plugin raw answered secrets\.load with a result that does not match the protocol: /,
    );
  });

  it("gives up on a call after timeoutSeconds and cancels it in the plugin", async () => {
    const lines: string[] = [];
    const registry = await load(
      { plugins: [fixture("raw", { args: ["stall"], timeoutSeconds: 1 })] },
      [],
      {
        log: (line) => lines.push(line),
      },
    );

    const failure = registry.secretProviders(["raw-secrets"])[0]!.load("ANY");

    await expect(failure).rejects.toBeInstanceOf(PluginCallTimedOut);
    await expect(failure).rejects.toThrow("plugin raw did not answer secrets.load within 1 s");
    await waitFor(() => lines.some((line) => line.startsWith("plugin raw: cancelled request ")));
  });

  it("close ends every process, a stubborn one by SIGKILL, and later calls fail at once", async () => {
    const [plainPid, stubbornPid] = [await pidFile(), await pidFile()];
    const registry = await load({
      plugins: [
        fixture("raw", { env: { RAW_PID_FILE: plainPid } }),
        fixture("raw", { args: ["stubborn"], env: { RAW_PID_FILE: stubbornPid } }),
      ],
    });
    const pids = [
      Number(await readFile(plainPid, "utf8")),
      Number(await readFile(stubbornPid, "utf8")),
    ];
    const provider = registry.secretProviders(["raw-secrets"])[0]!;

    await registry.close();
    await registry.close();

    expect(pids.map(running)).toEqual([false, false]);
    await expect(provider.load("ANY")).rejects.toThrow(
      new PluginProcessExited("plugin raw exited with code 0"),
    );
  }, 15_000);

  it("close ends a wrapper whose child holds the pipes open, and later calls fail at once", async () => {
    const pid = await pidFile();
    // close signals only the wrapper, so the plugin under it keeps running
    leftovers.push(pid);
    const script = `"${process.execPath}" --no-warnings "${join(FIXTURES, "raw.ts")}" stubborn; true`;
    const registry = await load({
      plugins: [{ command: ["sh", "-c", script], env: { RAW_PID_FILE: pid } }],
    });
    const provider = registry.secretProviders(["stubborn-secrets"])[0]!;

    const started = performance.now();
    await registry.close();

    expect(performance.now() - started).toBeLessThan(11_000);
    await expect(provider.load("ANY")).rejects.toBeInstanceOf(PluginProcessExited);
  }, 20_000);

  it("fails a pending call when the plugin exits while a child of its own holds the pipes open", async () => {
    const grandchild = await pidFile();
    leftovers.push(grandchild);
    const registry = await load({
      plugins: [
        fixture("raw", {
          args: ["orphan"],
          timeoutSeconds: 10,
          env: { RAW_GRANDCHILD_PID_FILE: grandchild },
        }),
      ],
    });

    await expect(registry.secretProviders(["raw-secrets"])[0]!.load("ANY")).rejects.toThrow(
      new PluginProcessExited("plugin raw exited with code 6"),
    );
  }, 15_000);

  it("answers -32602 to a host call that a launch context does not offer", async () => {
    const registry = await load({ plugins: [fixture("raw", { args: ["launch-http"] })] });

    const launching = registry.driver("raw").launch({
      env: demoEnv(),
      target: "proc",
      settings: {},
      runDir: FIXTURES,
      redactor: new Redactor(defaultRedactionRules()),
    });

    await expect(launching).rejects.toBeInstanceOf(PluginCallFailed);
    await expect(launching).rejects.toThrow(
      "plugin raw answered driver.launch with error -32602: host.http is not available in this context",
    );
  });

  it("answers -32602 to host.mask from a launch context", async () => {
    const registry = await load({ plugins: [fixture("raw", { args: ["launch-mask"] })] });

    const launching = registry.driver("raw").launch({
      env: demoEnv(),
      target: "proc",
      settings: {},
      runDir: FIXTURES,
      redactor: new Redactor(defaultRedactionRules()),
    });

    await expect(launching).rejects.toThrow(
      "plugin raw answered driver.launch with error -32602: host.mask is not available in this context",
    );
  });
});

describe("process plugins in a run", () => {
  it("ends a case blocked with internal:, never fail, when the driver plugin exits mid-step", async () => {
    const result = await runOnTarget(fixture("served"), "served", [
      { check: { name: "before", value: "shown" } },
      { exit: {} },
    ]);

    expect(result).toMatchObject({
      status: "blocked",
      reason: "internal: plugin served exited with code 5",
    });
  });

  it("answers -32602 to a host call that a step context does not offer, which ends the case blocked", async () => {
    const result = await runOnTarget(fixture("raw", { args: ["step-secret"] }), "raw", [
      { peek: {} },
    ]);

    expect(result).toMatchObject({
      status: "blocked",
      reason:
        "internal: plugin raw answered driver.step with error -32602: host.secret is not available in this context",
    });
  });

  it.each(["step-string-error", "step-codeless-error"])(
    "ends a case blocked with internal:, never fail, when driver.step answers an error that is not a JSON-RPC error object (%s)",
    async (mode) => {
      const result = await runOnTarget(fixture("raw", { args: [mode] }), "raw", [{ peek: {} }]);

      expect(result).toMatchObject({
        status: "blocked",
        reason:
          "internal: plugin raw answered driver.step with an error that is not a JSON-RPC error object",
      });
    },
  );

  it("gives a plugin set-cookie with its values joined in headers, and each value on its own in setCookie", async () => {
    const server = createServer((_req, res) =>
      res.writeHead(200, { "set-cookie": ["session=abc", "csrf=xyz"] }).end(),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const folder = await mkdtemp(join(tmpdir(), "process-plugin-"));
    folders.push(folder);
    const file = join(folder, "result.json");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cookies`;

    try {
      const plugin = fixture("raw", { args: ["step-cookies"], env: { RAW_RESULT_FILE: file } });
      await runOnTarget(plugin, "raw", [{ peek: { url } }]);

      const { headers, setCookie } = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      expect((headers as Record<string, string>)["set-cookie"]).toBe("session=abc, csrf=xyz");
      expect(setCookie).toEqual(["session=abc", "csrf=xyz"]);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  it("lets a process resolver whose plugin exits give way to the next resolver at arm", async () => {
    const fallback: ChallengeResolver = {
      name: "fallback",
      kinds: ["served-code"],
      requires: [],
      automated: true,
      resolve: async () => ({ kind: "value", value: "fallback-code" }),
    };
    const registry = await load({ plugins: [fixture("served")] });
    const crashing = registry.resolver("served-crash");
    const kind = registry.kind("served-code");
    const request = {
      kind: "served-code",
      caseId: "SHOP-OTP-001",
      identity: "shopper",
      step: 1,
      params: {},
    };

    const answered = await resolveChallenge(
      request,
      kind,
      [crashing, fallback],
      resolverContext(),
      async () => {},
    );

    expect(answered).toEqual({
      answer: { kind: "value", value: "fallback-code" },
      resolver: "fallback",
    });
    await expect(
      resolveChallenge(request, kind, [crashing], resolverContext(), async () => {}),
    ).rejects.toThrow('resolver "served-crash" could not arm: plugin served exited with code 4');
  });
});

/** Runs one case in env demo on target proc, whose driver is `driver` from the `plugin` entry. */
async function runOnTarget(plugin: object, driver: string, steps: object[]): Promise<CaseResult> {
  const { root, project, registry } = await loadTestProject(
    {
      [BRAND.configFile]: {
        envs: { demo: { production: false, hosts: ["127.0.0.1"] } },
        targets: { proc: { driver } },
        plugins: [plugin],
      },
      "cases/shop/proc.yaml": {
        cases: [
          {
            id: "SHOP-PROC-001",
            title: "a process step",
            stage: "acceptance",
            risk: "low",
            targets: ["proc"],
            steps,
          },
        ],
      },
    },
    [],
  );
  registries.push(registry);
  folders.push(root);
  const runId = "20261109-120000-0a1b";

  const [result] = await runCases({
    project,
    env: project.config.envs["demo"]!,
    cases: project.cases,
    registry,
    channel: { ask: async () => ({ kind: "timeout" }) },
    runDir: join(root, "runs", runId),
    runValues: new RunValues(runId, new Date("2026-11-09T12:00:00Z"), 7),
    seed: 7,
    redactor: new Redactor(defaultRedactionRules()),
    signal: new AbortController().signal,
  });
  return result!;
}

function demoEnv(): Environment {
  return {
    name: "demo",
    production: false,
    vars: {},
    hosts: new Set(),
    challenges: {},
    locale: "en",
    probes: [],
  };
}

function resolverContext(): ResolverContext {
  return {
    env: demoEnv(),
    http: {
      send: async () => {
        throw new Error("no request is expected");
      },
    },
    channel: { ask: async () => ({ kind: "timeout" }) },
    prompt: { runId: "20261109-120000-0a1b", timeoutMs: 1000 },
    stateDir: FIXTURES,
    secrets: async (key) => {
      throw new Error(`no secret ${key} is expected`);
    },
    now: () => new Date(),
    signal: new AbortController().signal,
  };
}
