import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { HttpRequestDraft } from "../auth/index.ts";
import { BRAND } from "../brand.ts";
import { assertProdWrite } from "../env/index.ts";
import type { ProcessPluginEntry } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import { CaseBlocked } from "../run/outcome.ts";
import { METHODS, PROTOCOL_VERSION } from "./protocol.ts";
import { proxyContributions, type HostCalls, type HostContext, type PluginCall } from "./proxies.ts";
import type { PluginManifest } from "./registry.ts";
import { JsonRpcPeer, RpcError } from "./rpc.ts";
import { BLOCKED, firstIssue, handleMethod, INVALID_PARAMS } from "./serve.ts";

const INTERNAL_ERROR = -32603;
const INITIALIZE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_WAIT_MS = 2_000;
const KILL_WAIT_MS = 3_000;
const OUTPUT_DRAIN_MS = 5_000;
const STDERR_TAIL_LINES = 20;

// read at run time, since the package file sits outside rootDir; the path holds from src/ and dist/ alike
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

type Methods = typeof METHODS;

/** A call to a process plugin got no answer the host can use; a case it stops ends blocked with `internal:`. */
export class PluginCallFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The plugin's process ended; every pending and later call fails with this. */
export class PluginProcessExited extends PluginCallFailed {}

/** The plugin did not answer within the entry's `timeoutSeconds`; the host sent `$/cancelRequest`. */
export class PluginCallTimedOut extends PluginCallFailed {}

/** A started process plugin, whose manifest holds proxies that call the process. */
export class ProcessPlugin {
  readonly manifest: PluginManifest;
  readonly #stop: () => Promise<void>;
  #stopping: Promise<void> | undefined;

  constructor(manifest: PluginManifest, stop: () => Promise<void>) {
    this.manifest = manifest;
    this.#stop = stop;
  }

  /** Sends `shutdown`, ends stdin, then sends SIGTERM and SIGKILL to a process that does not exit; safe to call twice. */
  close(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }
}

export interface ProcessPluginOptions {
  /** The project root, which `entry.cwd` is relative to. */
  root: string;
  /** The plugin API version the registry provides, sent in `initialize`. */
  apiVersion: number;
  /** The caller's masking log; gets each stderr line and `host.log` line as `plugin <name>: <line>`. */
  log(line: string): void;
  /** Masks the stderr lines a failed load quotes. */
  redactor: Redactor;
}

/**
 * Spawns the entry's command, sends `initialize` and returns the plugin with its contributions as proxies. Throws when
 * the process cannot start, exits or stalls before it answers, speaks another protocol version or offers a type a
 * process plugin cannot; the process is ended first.
 */
export async function startProcessPlugin(
  entry: ProcessPluginEntry,
  options: ProcessPluginOptions,
): Promise<ProcessPlugin> {
  const [command = "", ...args] = entry.command;
  // the plugin has no name until it answers initialize
  let label = entry.command.join(" ");
  const child = spawn(command, args, {
    cwd: resolve(options.root, entry.cwd),
    env: { ...process.env, ...entry.env },
    stdio: "pipe",
  });
  const log = (line: string): void => options.log(`plugin ${label}: ${line}`);
  const peer = new JsonRpcPeer(child.stdout, child.stdin, { log });

  const tail: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => {
    log(line);
    tail.push(options.redactor.text(line));
    if (tail.length > STDERR_TAIL_LINES) tail.shift();
  });

  const exit = Promise.withResolvers<void>();
  let exited: PluginProcessExited | undefined;
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError ??= error;
  });
  // a descendant that inherited stdout or stderr would hold close back for as long as it lives
  let drain: NodeJS.Timeout | undefined;
  child.once("exit", () => {
    drain = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, OUTPUT_DRAIN_MS);
  });
  // close comes after the pipes end, so every answer the plugin wrote before it exited has been read
  child.on("close", (code, signal) => {
    clearTimeout(drain);
    exited = new PluginProcessExited(
      spawnError === undefined
        ? `plugin ${label} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`
        : `plugin ${label} could not start: ${spawnError.message}`,
    );
    peer.close(exited);
    exit.resolve();
  });

  const send = async <M extends keyof Methods>(
    method: M,
    params: z.input<Methods[M]["params"]>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> => {
    try {
      return await peer.request(method, params, signal === undefined ? { timeoutMs } : { signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted === true && error === signal.reason) throw error;
      throw callError(label, method, timeoutMs, error);
    }
  };
  const parse = <M extends keyof Methods>(method: M, result: unknown): z.output<Methods[M]["result"]> => {
    const schema: z.ZodType = METHODS[method].result;
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
      throw new PluginCallFailed(
        `plugin ${label} answered ${method} with a result that does not match the protocol: ${at}${firstIssue(parsed.error)}`,
      );
    }
    return parsed.data as z.output<Methods[M]["result"]>;
  };
  const request = async <M extends keyof Methods>(
    method: M,
    params: z.input<Methods[M]["params"]>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<z.output<Methods[M]["result"]>> => parse(method, await send(method, params, signal, timeoutMs));
  const call: PluginCall = (method, params, signal) => request(method, params, signal, entry.timeoutSeconds * 1000);

  const stop = async (): Promise<void> => {
    if (exited !== undefined) return;
    await request("shutdown", {}, undefined, SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
    child.stdin.end();
    if (await settlesWithin(exit.promise, EXIT_WAIT_MS)) return;
    child.kill("SIGTERM");
    if (await settlesWithin(exit.promise, KILL_WAIT_MS)) return;
    child.kill("SIGKILL");
    await exit.promise;
  };

  const contexts = new Map<string, HostContext>();
  let nextContext = 0;
  const calls: HostCalls = {
    register(context) {
      const contextId = `context-${++nextContext}`;
      contexts.set(contextId, context);
      return contextId;
    },
    release(contextId) {
      contexts.delete(contextId);
    },
  };
  answerHostCalls(peer, contexts, log);

  try {
    const raw = await send(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, apiVersion: options.apiVersion, host: { name: BRAND.name, version } },
      undefined,
      INITIALIZE_TIMEOUT_MS,
    );
    // the version comes first, since the rest of the answer may have another shape in another version
    const theirs = z.looseObject({ protocolVersion: z.int(), name: z.string() }).safeParse(raw);
    if (theirs.success && theirs.data.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `plugin ${theirs.data.name} speaks protocol version ${theirs.data.protocolVersion}; this host speaks version ${PROTOCOL_VERSION}`,
      );
    }
    const answer = parse("initialize", raw);
    label = answer.name;
    const contributions = proxyContributions(call, answer.name, answer.contributions, calls);
    return new ProcessPlugin({ name: answer.name, apiVersion: answer.apiVersion, ...contributions }, stop);
  } catch (error) {
    await stop();
    if (!(error instanceof PluginProcessExited || error instanceof PluginCallTimedOut) || tail.length === 0) {
      throw error;
    }
    const Failure = error instanceof PluginProcessExited ? PluginProcessExited : PluginCallTimedOut;
    throw new Failure(`${error.message}; its last stderr lines:\n${tail.join("\n")}`);
  }
}

function callError(plugin: string, method: string, timeoutMs: number, error: unknown): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new PluginCallTimedOut(`plugin ${plugin} did not answer ${method} within ${timeoutMs / 1000} s`);
  }
  if (error instanceof RpcError) {
    // the plugin's handler threw, so a step fails as an in-process step that throws does
    if (error.code === INTERNAL_ERROR) return new Error(error.message);
    if (error.code === BLOCKED) return new CaseBlocked(error.message);
    return new PluginCallFailed(`plugin ${plugin} answered ${method} with error ${error.code}: ${error.message}`);
  }
  if (error instanceof PluginCallFailed) return error;
  // the peer closed itself, as after a line over its limit
  return new PluginCallFailed(
    `plugin ${plugin} cannot answer ${method}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Answers the plugin's `host.*` calls from the context registered under their `contextId`. A context that is unknown,
 * released or lacks what the method needs gets `-32602`. A resolver context offers secrets and http; a step context
 * offers resolve, http, evidence and values; a case ending offers evidence; a tracker client's context offers
 * secrets; a launch context offers nothing.
 */
function answerHostCalls(peer: JsonRpcPeer, contexts: ReadonlyMap<string, HostContext>, log: (line: string) => void) {
  const find = <T extends HostContext>(
    method: string,
    contextId: string,
    offers: (context: HostContext) => context is T,
  ): T => {
    const context = contexts.get(contextId);
    if (context === undefined || !offers(context)) {
      throw new RpcError(INVALID_PARAMS, `${method} is not available in this context`);
    }
    return context;
  };

  handleMethod(peer, "host.resolve", ({ contextId, value }) =>
    find("host.resolve", contextId, canResolve).resolve(value),
  );
  handleMethod(peer, "host.secret", async ({ contextId, key }) => {
    const context = find("host.secret", contextId, hasSecrets);
    return "secrets" in context ? context.secrets(key) : context.secret(key);
  });
  handleMethod(peer, "host.http", async ({ contextId, request, as, write }, signal) => {
    const context = find("host.http", contextId, hasHttp);
    assertProdWrite(context.env, request.method, { write });
    const draft: HttpRequestDraft = {
      method: request.method,
      url: new URL(request.url),
      headers: new Headers(request.headers),
      signal,
    };
    if (request.bodyBase64 !== undefined) draft.body = Buffer.from(request.bodyBase64, "base64");
    const response = await context.http.send(draft, as);
    // the body was parsed from JSON or is text
    const body = (response.body ?? null) as z.core.util.JSONType;
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  });
  handleMethod(peer, "host.evidence.record", async ({ contextId, check }) => {
    find("host.evidence.record", contextId, hasEvidence).evidence.record(check);
    return null;
  });
  handleMethod(peer, "host.evidence.note", async ({ contextId, text }) => {
    find("host.evidence.note", contextId, hasEvidence).evidence.note(text);
    return null;
  });
  handleMethod(peer, "host.evidence.followup", async ({ contextId, item, hint }) => {
    find("host.evidence.followup", contextId, hasEvidence).evidence.followup(item, hint);
    return null;
  });
  handleMethod(peer, "host.evidence.attach", async ({ contextId, label, ext, dataBase64 }) => {
    const { evidence } = find("host.evidence.attach", contextId, hasEvidence);
    return { name: await evidence.attach(label, Buffer.from(dataBase64, "base64"), ext) };
  });
  handleMethod(peer, "host.values.set", async ({ contextId, name, value }) => {
    find("host.values.set", contextId, hasValues).values.set(name, value);
    return null;
  });
  peer.handle("host.log", async (params) => {
    const parsed = METHODS["host.log"].params.safeParse(params);
    if (parsed.success) log(parsed.data.line);
  });
}

type ContextWith<K extends string> = Extract<HostContext, Record<K, unknown>>;

function canResolve(context: HostContext): context is ContextWith<"resolve"> {
  return "resolve" in context;
}

function hasSecrets(context: HostContext): context is ContextWith<"secrets"> | ContextWith<"secret"> {
  return "secrets" in context || "secret" in context;
}

function hasHttp(context: HostContext): context is ContextWith<"http"> {
  return "http" in context;
}

function hasEvidence(context: HostContext): context is ContextWith<"evidence"> {
  return "evidence" in context;
}

function hasValues(context: HostContext): context is ContextWith<"values"> {
  return "values" in context;
}

/** True when `promise` settles within `ms`; the timer never keeps the process alive after it does. */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      done(true);
    });
  });
}
