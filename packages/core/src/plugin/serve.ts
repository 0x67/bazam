import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { Identities } from "../auth/index.ts";
import type { HumanChannel, ResolverContext } from "../challenge/index.ts";
import type { Driver, DriverSession, LaunchOptions, StepEvidence, StepHandler } from "../driver/index.ts";
import type { GuardedHttp } from "../driver/http.ts";
import type { Environment } from "../env/index.ts";
import { defaultRedactionRules, Redactor } from "../redact/index.ts";
import type { TrackerConnection } from "../report/index.ts";
import { CaseBlocked, isBlocking } from "../run/outcome.ts";
import { METHODS, PROTOCOL_VERSION } from "./protocol.ts";
import type { PluginManifest } from "./registry.ts";
import { JsonRpcPeer, RpcError } from "./rpc.ts";

/** The protocol's error code for a blocking error, which ends the case blocked with the message. */
export const BLOCKED = -32001;
export const INVALID_PARAMS = -32602;

type Methods = typeof METHODS;
type Params<M extends keyof Methods> = z.output<Methods[M]["params"]>;
type Answer<M extends keyof Methods> = z.input<Methods[M]["result"]>;

// the manifest fields a process plugin cannot offer
const REFUSED = ["steps", "authStrategies", "checkRules", "channels", "trackers"] as const;
const NO_RUN_OBJECTS = "a process resolver cannot reach the run's channel or session";

/**
 * Answers `method` with its params parsed. A blocking error answers `-32001`, an `RpcError` keeps its code, and any
 * other error answers `-32603`.
 */
export function handleMethod<M extends keyof Methods>(
  peer: JsonRpcPeer,
  method: M,
  answer: (params: Params<M>, signal: AbortSignal) => Promise<Answer<M>>,
): void {
  peer.handle(method, async (raw, signal) => {
    const schema: z.ZodType = METHODS[method].params;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new RpcError(INVALID_PARAMS, firstIssue(parsed.error));
    try {
      return await answer(parsed.data as Params<M>, signal);
    } catch (error) {
      throw isBlocking(error) ? new RpcError(BLOCKED, error.message) : error;
    }
  });
}

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? error.message;
}

/**
 * Serves an in-process manifest as a process plugin until `input` ends. By default `input` and `output` are stdin and
 * stdout, so the plugin must keep stdout for the protocol and write its own logs to stderr. Rejects at start a
 * manifest that offers a type a process plugin cannot, or a step schema that JSON Schema cannot represent, naming the
 * step kind. Rejects with the reason, and destroys `input`, when the connection closes on a line over 64 MiB.
 */
export async function serveProcessPlugin(
  manifest: PluginManifest,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const contributions = describe(manifest);
  const ended = new Promise<void>((done) => {
    io.input.once("end", done);
    io.input.once("close", done);
  });
  const peer = new JsonRpcPeer(io.input, io.output, {});
  serve(peer, manifest, contributions);
  const closed = await Promise.race([ended.then(() => undefined), peer.closed]);
  if (closed !== undefined) {
    // a peer that closed itself answers nothing more, so the plugin exits and the host sees the exit
    io.input.destroy();
    throw closed;
  }
  peer.close(new Error("the host closed the connection"));
}

function describe(manifest: PluginManifest): Answer<"initialize">["contributions"] {
  for (const key of REFUSED) {
    if ((manifest[key]?.length ?? 0) > 0) {
      throw new Error(`plugin ${manifest.name} offers ${key}, which a process plugin cannot offer; load it in-process`);
    }
  }
  return {
    resolvers: (manifest.resolvers ?? []).map((resolver) => ({
      name: resolver.name,
      kinds: [...resolver.kinds],
      requires: [...resolver.requires],
      automated: resolver.automated,
      arm: resolver.arm !== undefined,
    })),
    challengeKinds: [...(manifest.challengeKinds ?? [])],
    secretProviders: (manifest.secretProviders ?? []).map(({ name }) => ({ name })),
    resultFormats: (manifest.resultFormats ?? []).map(({ name }) => ({ name })),
    trackerClients: (manifest.trackerClients ?? []).map(({ tracker }) => ({ tracker })),
    drivers: (manifest.drivers ?? []).map((driver) => ({
      name: driver.name,
      surface: driver.surface,
      steps: driver.steps.map((step) => ({ kind: step.kind, schema: jsonSchema(driver, step) })),
    })),
  };
}

function jsonSchema(driver: Driver, step: StepHandler): z.core.JSONSchema.JSONSchema {
  try {
    return z.toJSONSchema(step.schema, { io: "input" });
  } catch (error) {
    throw new Error(
      `step ${step.kind} of driver ${driver.name} has a schema that JSON Schema cannot represent: ${messageOf(error)}`,
    );
  }
}

function serve(
  peer: JsonRpcPeer,
  manifest: PluginManifest,
  contributions: Answer<"initialize">["contributions"],
): void {
  // registers every host.secret answer; its screenshot selectors are the ones the latest probe or launch sent
  const redactor = new Redactor(defaultRedactionRules());
  const sessions = new Map<string, { driver: Driver; session: DriverSession }>();
  // a connection's TrackerClientContext reads secrets with the context id of the call that runs on it
  const connections = new Map<string, { connection: TrackerConnection; call: { contextId: string } }>();
  let nextId = 0;

  const host = async <M extends keyof Methods>(
    method: M,
    params: z.input<Methods[M]["params"]>,
    signal?: AbortSignal,
  ): Promise<z.output<Methods[M]["result"]>> => {
    let result: unknown;
    try {
      result = await peer.request(method, params, signal === undefined ? {} : { signal });
    } catch (error) {
      throw error instanceof RpcError && error.code === BLOCKED ? new CaseBlocked(error.message) : error;
    }
    const schema: z.ZodType = METHODS[method].result;
    return schema.parse(result) as z.output<Methods[M]["result"]>;
  };

  const secret = async (contextId: string, key: string): Promise<string> => {
    const value = await host("host.secret", { contextId, key });
    redactor.register(value);
    return value;
  };

  const http = (contextId: string, write: boolean, signal: AbortSignal): GuardedHttp => ({
    async send(request, as) {
      const body = request.body === undefined ? {} : { bodyBase64: Buffer.from(request.body).toString("base64") };
      const response = await host(
        "host.http",
        {
          contextId,
          request: {
            method: request.method,
            url: request.url.href,
            headers: Object.fromEntries(request.headers),
            ...body,
            ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
          },
          ...(as === undefined ? {} : { as }),
          ...(write ? { write } : {}),
        },
        request.signal ?? signal,
      );
      const headers = new Headers(response.headers);
      if (response.setCookie !== undefined) {
        headers.delete("set-cookie");
        for (const cookie of response.setCookie) headers.append("set-cookie", cookie);
      }
      return { status: response.status, headers, body: response.body ?? undefined };
    },
  });

  const evidence = (contextId: string, fired: Fired): StepEvidence => ({
    record(check) {
      fired.add(host("host.evidence.record", { contextId, check }));
      return check.ok;
    },
    note(text) {
      fired.add(host("host.evidence.note", { contextId, text }));
    },
    followup(item, hint) {
      fired.add(host("host.evidence.followup", { contextId, item, hint }));
    },
    async attach(label, bytes, ext) {
      const dataBase64 = Buffer.from(bytes).toString("base64");
      // a zip goes out as asked, and the host refuses it with its reason
      const wireExt = ext as Exclude<typeof ext, "zip">;
      return (await host("host.evidence.attach", { contextId, label, ext: wireExt, dataBase64 })).name;
    },
  });

  const launchOptions = (wire: Params<"driver.launch">["options"]): LaunchOptions => {
    redactor.configure({ patterns: [], screenshotSelectors: wire.redaction.screenshotSelectors });
    return { env: environment(wire.env), target: wire.target, settings: wire.settings, runDir: wire.runDir, redactor };
  };

  const resolverContext = (wire: Params<"resolver.arm">["context"], signal: AbortSignal): ResolverContext => ({
    env: environment(wire.env),
    http: http(wire.contextId, false, signal),
    session: unavailable<DriverSession>(NO_RUN_OBJECTS),
    channel: unavailable<HumanChannel>(NO_RUN_OBJECTS),
    prompt: wire.prompt,
    stateDir: wire.stateDir,
    secrets: (key) => secret(wire.contextId, key),
    now: () => new Date(),
    signal,
  });

  const launched = (session: string) => {
    const found = sessions.get(session);
    if (found === undefined) throw new Error(`no session ${session} is open`);
    return found;
  };

  const connected = (params: { connection: string; contextId: string }): TrackerConnection => {
    const found = connections.get(params.connection);
    if (found === undefined) throw new Error(`no connection ${params.connection} is open`);
    found.call.contextId = params.contextId;
    return found.connection;
  };

  handleMethod(peer, "initialize", async () => ({
    protocolVersion: PROTOCOL_VERSION,
    name: manifest.name,
    apiVersion: manifest.apiVersion,
    contributions,
  }));
  handleMethod(peer, "shutdown", async () => null);

  handleMethod(peer, "resolver.arm", async ({ resolver, request, context }, signal) => {
    await named(manifest.resolvers, resolver, "resolver").arm?.(request, resolverContext(context, signal));
    return null;
  });
  handleMethod(peer, "resolver.resolve", async ({ resolver, request, kind, context }, signal) => {
    if (kind === undefined) throw new RpcError(INVALID_PARAMS, "resolver.resolve needs the challenge kind");
    const answer = await named(manifest.resolvers, resolver, "resolver").resolve(
      request,
      resolverContext(context, signal),
      kind,
    );
    return answer ?? null;
  });

  handleMethod(peer, "secrets.load", async ({ provider, key }) => {
    return (await named(manifest.secretProviders, provider, "secret provider").load(key)) ?? null;
  });

  handleMethod(peer, "results.parse", async ({ format, file }) => {
    const tests = await named(manifest.resultFormats, format, "result format").parse(file);
    return tests.map((test) => ({ ...test, title: [...test.title], tags: [...test.tags] }));
  });

  handleMethod(peer, "trackerClient.connect", async ({ tracker, contextId, config }, signal) => {
    const client = manifest.trackerClients?.find((candidate) => candidate.tracker === tracker);
    if (client === undefined) throw new Error(`plugin ${manifest.name} has no tracker client ${tracker}`);
    const call = { contextId };
    const connection = await client.connect({
      config,
      secret: (name) => secret(call.contextId, name),
      redactor,
      signal,
      log: (line) => peer.notify("host.log", { line }),
    });
    const id = `connection-${++nextId}`;
    connections.set(id, { connection, call });
    return { connection: id };
  });
  handleMethod(peer, "trackerClient.ticket", async (params) => connected(params).ticket(params.key));
  handleMethod(peer, "trackerClient.attach", async (params) => {
    await connected(params).attach(params.key, params.files);
    return null;
  });
  handleMethod(peer, "trackerClient.postComment", async (params) =>
    connected(params).postComment(params.key, params.comment, params.mentions),
  );
  handleMethod(peer, "trackerClient.editComment", async (params) => {
    return (await connected(params).editComment(params.key, params.url, params.comment, params.mentions)) ?? null;
  });
  handleMethod(peer, "trackerClient.transition", async (params) => {
    await connected(params).transition(params.key, params.name);
    return null;
  });
  handleMethod(peer, "trackerClient.findOpenBug", async (params) => {
    return (await connected(params).findOpenBug(params.project, params.label)) ?? null;
  });
  handleMethod(peer, "trackerClient.createBug", async (params) => connected(params).createBug(params.draft));

  handleMethod(peer, "driver.probe", async ({ driver, options }) => {
    return [...(await named(manifest.drivers, driver, "driver").probe(launchOptions(options)))];
  });
  handleMethod(peer, "driver.launch", async ({ driver, options }) => {
    const found = named(manifest.drivers, driver, "driver");
    const session = await found.launch(launchOptions(options));
    const id = `session-${++nextId}`;
    sessions.set(id, { driver: found, session });
    return { session: id, capabilities: [...session.capabilities] };
  });
  handleMethod(peer, "driver.step", async ({ session, kind, step, context }, signal) => {
    const { driver, session: open } = launched(session);
    const handler = driver.steps.find((candidate) => candidate.kind === kind);
    if (handler === undefined) throw new Error(`driver ${driver.name} has no ${kind} step`);
    // refinements and transforms do not cross as JSON Schema, so the handler's own schema has the last word
    const parsed = handler.schema.safeParse(step);
    if (!parsed.success) throw new CaseBlocked(`step ${kind} does not match its schema: ${issuesOf(parsed.error)}`);
    // a case author opts a step into a production write with write: true, as for the core request step
    const write =
      typeof parsed.data === "object" && parsed.data !== null && "write" in parsed.data && parsed.data.write === true;
    const { contextId } = context;
    const fired = new Fired();
    await fired.after(() =>
      handler.run(parsed.data, {
        session: open,
        ...(context.identity === undefined ? {} : { identity: context.identity }),
        env: environment(context.env),
        evidence: evidence(contextId, fired),
        identities: unavailable<Identities>("identities are not available in a process plugin"),
        values: new HostValues(context.values, (name, value) =>
          fired.add(host("host.values.set", { contextId, name, value })),
        ),
        http: http(contextId, write, signal),
        resolve: async <T>(value: T) =>
          (await host("host.resolve", { contextId, value: value as z.core.util.JSONType }, signal)) as T,
        signal,
      }),
    );
    return null;
  });
  handleMethod(peer, "driver.close", async ({ session, ending, context }) => {
    const { session: open } = launched(session);
    sessions.delete(session);
    const fired = new Fired();
    await fired.after(() => open.close({ status: ending.status, evidence: evidence(context.contextId, fired) }));
    return null;
  });
}

/**
 * Host calls a handler fires without waiting, such as `record`. Each failure is caught when it happens, so it cannot
 * go unhandled, and the handler's answer waits for all of them.
 */
class Fired {
  readonly #calls: Promise<void>[] = [];
  #failure: { error: unknown } | undefined;

  add(call: Promise<unknown>): void {
    this.#calls.push(
      call.then(
        () => undefined,
        (error: unknown) => {
          this.#failure ??= { error };
        },
      ),
    );
  }

  /** Runs `run`, then waits for the calls it fired; throws the handler's error first, else the first failed call's. */
  async after(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } finally {
      await Promise.all(this.#calls);
    }
    if (this.#failure !== undefined) throw this.#failure.error;
  }
}

/** A step's values; `set` also saves the value on the host. */
class HostValues extends Map<string, string> {
  readonly #save: (name: string, value: string) => void;

  constructor(values: Record<string, string>, save: (name: string, value: string) => void) {
    super();
    for (const [name, value] of Object.entries(values)) super.set(name, value);
    this.#save = save;
  }

  override set(name: string, value: string): this {
    this.#save(name, value);
    return super.set(name, value);
  }
}

function environment(wire: Params<"driver.step">["context"]["env"]): Environment {
  return { ...wire, hosts: new Set(wire.hosts) };
}

/** An object that throws `message` on any use, for what stays in the host's run. */
function unavailable<T extends object>(message: string): T {
  const refuse = (): never => {
    throw new Error(message);
  };
  return new Proxy({}, { get: refuse, set: refuse, has: refuse }) as T;
}

function named<T extends { name: string }>(items: readonly T[] | undefined, name: string, noun: string): T {
  const found = items?.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no ${noun} ${name} is served here`);
  return found;
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
