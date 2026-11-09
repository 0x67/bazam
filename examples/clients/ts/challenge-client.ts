/// <reference types="node" />
import { Agent, request as httpRequest } from "node:http";

// A challenge service client for suites in other repositories to copy; it imports only node:http.
// `bazam exec` and runner targets set the two variables below; docs/challenge-service.md has the contract.

const URL_VAR = "BAZAM_CHALLENGE_URL";
const TOKEN_VAR = "BAZAM_CHALLENGE_TOKEN";

/** The body of `POST /challenge`. The service takes a missing `identity` as "tester" and a missing `step` as 1. */
export interface ChallengeClientRequest {
  kind: string;
  caseId: string;
  params?: Record<string, string>;
  identity?: string;
  step?: number;
}

export type ChallengeClientAnswer = { value: string } | { done: true };

/** The service answered with a status other than 200, or with a body that is not an answer. */
export class ChallengeRequestFailed extends Error {
  readonly status: number;

  constructor(status: number, error: string) {
    super(`challenge service answered ${status}: ${error}`);
    this.name = "ChallengeRequestFailed";
    this.status = status;
  }
}

export interface ChallengeClientOptions {
  /** The endpoint; read from BAZAM_CHALLENGE_URL when left out. */
  url?: string;
  /** Read from BAZAM_CHALLENGE_TOKEN when left out. */
  token?: string;
  /** No limit when left out, since the service bounds each request. A limit also counts the time a prompt waits in the queue. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Reply {
  status: number;
  text: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// an agent of its own, so no proxy setting routes the request
const agent = new Agent();

/**
 * Asks the challenge service for an answer. Refuses a URL that is not loopback http before sending, and
 * throws `ChallengeRequestFailed` for any status other than 200.
 */
export async function requestChallenge(
  request: ChallengeClientRequest,
  options: ChallengeClientOptions = {},
): Promise<ChallengeClientAnswer> {
  const url = options.url ?? process.env[URL_VAR];
  const token = options.token ?? process.env[TOKEN_VAR];
  if (!url || !token) {
    throw new Error(
      `the challenge client needs ${URL_VAR} and ${TOKEN_VAR}: run this test under \`bazam exec\` or a runner target`,
    );
  }
  const endpoint = loopbackUrl(url);
  const limit = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signal = limit && options.signal ? AbortSignal.any([limit, options.signal]) : (limit ?? options.signal);
  const reply = await post(endpoint, token, JSON.stringify(request), signal);
  return answerOf(reply);
}

function loopbackUrl(text: string): URL {
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (url?.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("the challenge service URL must be a loopback http URL");
  }
  return url;
}

function post(url: URL, token: string, body: string, signal: AbortSignal | undefined): Promise<Reply> {
  return new Promise((done, fail) => {
    const failed = (error: Error): void => fail(signal?.aborted ? signal.reason : error);
    const req = httpRequest(
      url,
      {
        method: "POST",
        agent,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        ...(signal === undefined ? {} : { signal }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.once("error", failed);
      },
    );
    req.once("error", failed);
    req.end(body);
  });
}

function answerOf({ status, text }: Reply): ChallengeClientAnswer {
  const json = objectOf(text);
  if (status === 200 && typeof json["value"] === "string") return { value: json["value"] };
  if (status === 200 && json["done"] === true) return { done: true };
  throw new ChallengeRequestFailed(status, typeof json["error"] === "string" ? json["error"] : text);
}

function objectOf(text: string): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
