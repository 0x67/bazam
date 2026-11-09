import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { BRAND } from "../brand.ts";
import type { GuardedHttp } from "../driver/http.ts";
import type { Environment } from "../env/index.ts";
import type { PluginRegistry } from "../plugin/index.ts";
import type { Redactor } from "../redact/index.ts";
import type { CaseResult } from "../result/index.ts";
import { oneAtATime, type HumanChannel, type PersonPrompt } from "./human.ts";
import type { ChallengeKindSpec } from "./kinds.ts";
import {
  ChallengeBlocked,
  resolveChallenge,
  type ChallengeRequest,
  type ChallengeResolver,
  type ResolverContext,
} from "./resolver.ts";

/** The full endpoint, `http://127.0.0.1:<port>/challenge`. */
export const CHALLENGE_URL_VAR = `${BRAND.envPrefix}CHALLENGE_URL`;
/** The bearer token the endpoint wants. */
export const CHALLENGE_TOKEN_VAR = `${BRAND.envPrefix}CHALLENGE_TOKEN`;
export const RUN_ID_VAR = `${BRAND.envPrefix}RUN_ID`;
export const ENV_VAR = `${BRAND.envPrefix}ENV`;
/** The selected case ids of a runner target, comma separated. */
export const CASES_VAR = `${BRAND.envPrefix}CASES`;

const HOST = "127.0.0.1";
const PATH = "/challenge";
const BODY_LIMIT_BYTES = 16 * 1024;
const TOKEN_BYTES = 32;
// as long as the runner gives a person to answer a challenge prompt
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// the case id goes into a prompt id, which answersFileChannel turns into a file name
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The body of `POST /challenge`. A request that leaves out `identity` acts as "tester", which human prompts
 * name, and one that leaves out `step` is step 1, so its prompt id is `<caseId>-1-<kind>`; a caller that
 * answers several challenges of one kind in a case passes `step` to tell their prompts apart.
 */
const ServiceRequest = z.strictObject({
  kind: z.string().min(1),
  caseId: z.string().regex(PLAIN_NAME, { error: "caseId must be letters, digits, dots, dashes and underscores" }),
  params: z.record(z.string(), z.string()).default({}),
  identity: z.string().min(1).default("tester"),
  step: z.int().positive().default(1),
});

export interface ChallengeServiceDeps {
  env: Environment;
  registry: Pick<PluginRegistry, "kind" | "resolverChain">;
  /** Where the `human` resolver asks; prompts reach it masked, since the caller writes their text. */
  channel: HumanChannel;
  http: GuardedHttp;
  /** `<root>/<stateDir>`, as resolvers get it in a run. */
  stateDir: string;
  secrets(key: string): Promise<string>;
  /** Gets the token and every value answer registered; masks error bodies and log lines. */
  redactor: Redactor;
  /** Prompts carry it, as they do in a run. */
  runId: string;
  /**
   * How long a person has to answer, counted from when their prompt is shown, as in a run; five minutes when
   * left out. Automated resolvers keep their own limits, such as otp-mailpit's timeoutSeconds.
   */
  timeoutMs?: number;
  now?(): Date;
  /** Gets one line per request. */
  log?(line: string): void;
}

export interface ChallengeService {
  /** `http://127.0.0.1:<port>/challenge`, the one endpoint, at the address the server listens on. */
  url: URL;
  /** The bearer token every request must carry. */
  token: string;
  /** The requests answered with a value or done so far, by case id, in the order answered. */
  answered(): ReadonlyMap<string, CaseResult["challenges"]>;
  /** Cancels the requests still waiting, closes their connections and stops listening. */
  close(): Promise<void>;
}

interface Reply {
  status: number;
  body: { value: string } | { done: true } | { error: string };
}

/**
 * Serves `POST /challenge` on loopback for tests outside the runner: 200 `{ value }` or `{ done: true }`,
 * or a status with `{ error }`. 401 without the token, 404 and 405 off the endpoint, 413 for a body over
 * 16 KiB, 400 for a body that is not a request or names an unknown kind, 500 for a resolver chain the
 * config gets wrong, 502 when the chain gives no answer and 504 when the person does not answer in time.
 * The trigger already ran in the caller's test, so no resolver is armed. Requests run side by side, but the
 * person gets their prompts one at a time, in the order asked.
 */
export async function startChallengeService(deps: ChallengeServiceDeps): Promise<ChallengeService> {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  deps.redactor.register(token);
  const tokenDigest = digest(token);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closing = new AbortController();
  const queued = oneAtATime(deps.channel);
  const log = (line: string): void => deps.log?.(deps.redactor.text(line));
  const answered = new Map<string, CaseResult["challenges"]>();

  const authorized = (header: string | undefined): boolean => {
    const given = /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
    // equal-length digests, since timingSafeEqual throws on a length mismatch
    return given !== undefined && timingSafeEqual(digest(given), tokenDigest);
  };

  const respond = async (req: IncomingMessage, hungUp: AbortSignal): Promise<Reply> => {
    if (!authorized(req.headers.authorization)) return failure(401, "missing or wrong bearer token");
    if (new URL(req.url ?? "/", `http://${HOST}`).pathname !== PATH) return failure(404, `the endpoint is ${PATH}`);
    if (req.method !== "POST") return failure(405, `send POST ${PATH}`);
    const body = await readBody(req);
    if (body === undefined) return failure(413, `the body is over ${BODY_LIMIT_BYTES} bytes`);
    let json: unknown;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      return failure(400, "the body is not JSON");
    }
    const parsed = ServiceRequest.safeParse(json);
    if (!parsed.success) return failure(400, z.prettifyError(parsed.error));
    return resolve(parsed.data, hungUp);
  };

  const resolve = async (request: ChallengeRequest, hungUp: AbortSignal): Promise<Reply> => {
    let kind: ChallengeKindSpec;
    try {
      kind = deps.registry.kind(request.kind);
    } catch (error) {
      return failure(400, messageOf(error));
    }
    let chain: ChallengeResolver[];
    try {
      chain = deps.registry.resolverChain(deps.env, request.kind).map(withoutArm);
    } catch (error) {
      // a resolver that does not answer the kind, or an automated one for a human-only kind
      return failure(500, messageOf(error));
    }
    // no deadline over the whole chain, as in a run: a person's window starts when their prompt is shown
    const signal = AbortSignal.any([closing.signal, hungUp]);
    const person = { timedOut: false };
    const ctx: ResolverContext = {
      env: deps.env,
      http: deps.http,
      channel: personChannel(queued, deps.redactor, person),
      prompt: { runId: deps.runId, timeoutMs },
      stateDir: deps.stateDir,
      secrets: (key) => deps.secrets(key),
      now: () => deps.now?.() ?? new Date(),
      signal,
    };
    try {
      const resolved = await untilAborted(resolveChallenge(request, kind, chain, ctx, noTrigger), signal);
      log(`challenge ${request.kind} for ${request.caseId}: answered by ${resolved.resolver}`);
      const challenges = answered.get(request.caseId) ?? [];
      challenges.push({ step: request.step, kind: request.kind, resolver: resolved.resolver });
      answered.set(request.caseId, challenges);
      if (resolved.answer.kind === "done") return { status: 200, body: { done: true } };
      deps.redactor.register(resolved.answer.value);
      return { status: 200, body: { value: resolved.answer.value } };
    } catch (error) {
      if (person.timedOut) return failure(504, `no answer within ${Math.ceil(timeoutMs / 1000)} s`);
      if (error instanceof ChallengeBlocked) return failure(502, error.message);
      if (closing.signal.aborted) return failure(503, "the challenge service is stopping");
      // nginx's code for a caller that closed its request; only the log sees it
      if (hungUp.aborted) return failure(499, "the caller hung up");
      return failure(500, messageOf(error));
    }
  };

  const server = createServer((req, res) => {
    const hungUp = new AbortController();
    // a caller that gives up, as a test runner does at its own timeout, takes its prompt away from the person
    res.once("close", () => {
      if (!res.writableFinished) hungUp.abort(new Error("the caller hung up"));
    });
    respond(req, hungUp.signal)
      .catch((error: unknown) => failure(500, messageOf(error)))
      .then((reply) => {
        const masked = "error" in reply.body ? { error: deps.redactor.text(reply.body.error) } : reply.body;
        if ("error" in masked) log(`challenge request answered ${reply.status}: ${masked.error}`);
        // the value goes back as it is: the caller types it into its app
        send(res, reply.status, masked);
      })
      .catch(() => {
        // the caller hung up, or close() dropped the connection
      });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, HOST, () => {
      server.off("error", fail);
      done();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://${address}:${port}${PATH}`),
    token,
    answered: () => answered,
    async close() {
      closing.abort(new Error("the challenge service is stopping"));
      // a request waiting on a person holds its connection for minutes, so close would wait that long
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function failure(status: number, error: string): Reply {
  return { status, body: { error } };
}

function send(res: ServerResponse, status: number, body: Reply["body"]): void {
  if (res.destroyed) return;
  // a body cut short at the limit leaves bytes the connection cannot be reused after
  const close = status === 413 ? { connection: "close" } : {};
  res.writeHead(status, { "content-type": "application/json", ...close }).end(JSON.stringify(body));
}

/** The body, or undefined once it passes the limit; the rest is read and dropped so the reply still arrives. */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (Number(req.headers["content-length"]) > BODY_LIMIT_BYTES) {
    req.resume();
    return Promise.resolve(undefined);
  }
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= BODY_LIMIT_BYTES) {
        chunks.push(chunk);
        return;
      }
      req.off("data", collect);
      req.resume();
      done(undefined);
    };
    req.on("data", collect);
    req.once("end", () => done(Buffer.concat(chunks)));
    req.once("error", fail);
  });
}

/** Masks the prompt the caller wrote into, and counts a timeout, which humanResolver reports only as text. */
function personChannel(queued: HumanChannel, redactor: Redactor, person: { timedOut: boolean }): HumanChannel {
  return {
    async ask(prompt, signal) {
      const masked: PersonPrompt = {
        ...prompt,
        title: redactor.text(prompt.title),
        steps: prompt.steps.map((step) => redactor.text(step)),
      };
      const answer = await queued.ask(masked, signal);
      if (answer.kind === "timeout") person.timedOut = true;
      return answer;
    },
  };
}

/** A copy without arm: the caller's test ran the trigger before it asked. */
function withoutArm(resolver: ChallengeResolver): ChallengeResolver {
  return {
    name: resolver.name,
    kinds: resolver.kinds,
    requires: resolver.requires,
    automated: resolver.automated,
    resolve: resolver.resolve.bind(resolver),
  };
}

async function noTrigger(): Promise<void> {}

/** Rejects with the signal's reason when it aborts first, so a resolver that ignores the signal cannot hold the reply. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = (): void => aborted.reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
