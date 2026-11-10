import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialCache, Identities } from "@bazam/core/auth";
import type { Step } from "@bazam/core/case";
import { guardedHttp, type DriverSession, type StepContext } from "@bazam/core/driver";
import { EnvsConfig, resolvePlaceholders, type Environment } from "@bazam/core/env";
import { Redactor, defaultRedactionRules } from "@bazam/core/redact";
import { EvidenceStore } from "@bazam/core/result";
import { playwrightDriver, WebSession } from "../../src/driver.ts";

export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = (typeof ENGINES)[number];

export type Handler = (request: IncomingMessage, response: ServerResponse, site: Site) => void;

export interface SeenRequest {
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
}

/** A local site on 127.0.0.1; the same server answers as `localhost`, a host the test env does not allow. */
export interface Site {
  origin: string;
  /** The same server under a host outside the allowlist. */
  elsewhere: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

export async function startSite(routes: Record<string, Handler>): Promise<Site> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ host: request.headers.host ?? "", path, headers: request.headers });
    const handler = routes[new URL(path, "http://site.test").pathname];
    if (handler === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    handler(request, response, site);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const site: Site = {
    origin: `http://127.0.0.1:${port}`,
    elsewhere: `http://localhost:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return site;
}

export function html(body: string): Handler {
  return (_request, response, site) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html><body>${body.replaceAll("{elsewhere}", site.elsewhere)}</body></html>`);
  };
}

export function demoEnv(): Environment {
  const envs = EnvsConfig.parse({ demo: { production: false, hosts: ["127.0.0.1"] } });
  return envs["demo"]!;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "driver-web-test-"));
}

export async function launch(
  engine: Engine,
  options: { env: Environment; runDir: string; redactor?: Redactor; settings?: Record<string, unknown> },
): Promise<WebSession> {
  const session = await playwrightDriver.launch({
    env: options.env,
    target: "web",
    settings: { browser: engine, ...options.settings },
    runDir: options.runDir,
    redactor: options.redactor ?? new Redactor(defaultRedactionRules()),
  });
  if (!(session instanceof WebSession))
    throw new Error("the playwright driver launched something other than a WebSession");
  return session;
}

/** A step context like the runner's, with `${case.<name>}` read from `values`. */
export function stepContext(
  session: DriverSession,
  options: {
    env: Environment;
    evidence: EvidenceStore;
    root: string;
    identity?: string;
    values?: Record<string, string>;
  },
): StepContext {
  const { env, evidence, root } = options;
  const redactor = new Redactor(defaultRedactionRules());
  const values = new Map(Object.entries(options.values ?? {}));
  return {
    session,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    env,
    evidence,
    identities: new Identities({
      env,
      configs: {},
      fixtures: {},
      registry: {
        strategy: (name) => {
          throw new Error(`no strategy ${name} in this test`);
        },
      },
      cache: new CredentialCache(join(root, "credentials")),
      lockDir: join(root, "locks"),
      resolve: async (value) => value,
      redactor,
      log: () => {},
      projectRoot: root,
      channel: { ask: async () => ({ kind: "timeout" }) },
      now: () => new Date(),
    }),
    values,
    http: guardedHttp({ env, redactor, log: () => {} }),
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
}

/** Runs each step through the driver's handler for its kind, as the runner dispatches them. */
export async function runSteps(ctx: StepContext, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    const [kind, payload] = Object.entries(step).find(([key]) => key !== "as")!;
    const handler = playwrightDriver.steps.find((candidate) => candidate.kind === kind);
    if (handler === undefined) throw new Error(`the playwright driver has no ${kind} step`);
    await handler.run(handler.schema.parse(payload), ctx);
  }
}

/** Runs `steps`, then short waits until a step throws, for a refusal that lands after the step that caused it. */
export async function runUntilThrown(ctx: StepContext, steps: readonly Step[], timeout = 10_000): Promise<void> {
  await runSteps(ctx, steps);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) await runSteps(ctx, [{ wait: { ms: 50 } }]);
}

export function newEvidence(runDir: string, caseId: string): EvidenceStore {
  return new EvidenceStore(runDir, caseId, new Redactor(defaultRedactionRules()));
}
