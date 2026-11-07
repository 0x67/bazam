import { setTimeout as sleep } from "node:timers/promises";
import type { ChallengeRequest, ChallengeResolver } from "@bazam/core/challenge";
import type { GuardedHttp, HttpResponse } from "@bazam/core/driver";

const DEFAULT_URL = "http://localhost:8025";
const DEFAULT_SEARCH_PATH = "/api/v1/search";
const DEFAULT_MESSAGE_PATH = "/api/v1/message";
const DEFAULT_PATTERN = String.raw`\b(\d{6})\b`;
const DEFAULT_TIMEOUT_SECONDS = "30";
const POLL_MS = 500;
// the challenge service skips arm because the caller already ran the trigger, so the mail may be a little older
const LOOK_BACK_MS = 30_000;

// IDs of the recipient's mail at arm; Mailpit stamps mail with its own clock, which may not match ours
const heldAtArm = new WeakMap<ChallengeRequest, ReadonlySet<string>>();

interface Inbox {
  url: string;
  searchPath: string;
  messagePath: string;
  recipient: string;
  pattern: RegExp;
  timeoutMs: number;
}

interface Mail {
  id: string;
  /** Epoch milliseconds on Mailpit's clock. */
  created: number;
}

interface Found {
  /** Mail to the recipient, newest first. */
  mail: Mail[];
  /** Epoch milliseconds on Mailpit's clock from the answer's Date header; undefined when it is missing or does not parse. */
  date: number | undefined;
}

/**
 * Answers `otp-email` from a Mailpit inbox with the first capture of `params.pattern` in the newest mail
 * to `params.recipient` that arrived after arm. Optional params and their defaults: `url` (Mailpit's base URL,
 * http://localhost:8025), `searchPath` (/api/v1/search), `messagePath` (/api/v1/message), `pattern`
 * (\b(\d{6})\b) and `timeoutSeconds` (30), how long arm and resolve each wait before they give up.
 */
export const mailpitResolver: ChallengeResolver = {
  name: "otp-mailpit",
  kinds: ["otp-email"],
  requires: [],
  automated: true,
  async arm(request, ctx) {
    const inbox = inboxOf(request.params);
    const held = await withTimeout(inbox, ctx.signal, (stop) => search(ctx.http, inbox, stop));
    if (held === undefined) throw new Error(`Mailpit did not answer within ${inbox.timeoutMs / 1000} s`);
    heldAtArm.set(request, new Set(held.mail.map((mail) => mail.id)));
  },
  async resolve(request, ctx) {
    const inbox = inboxOf(request.params);
    const held = heldAtArm.get(request);
    let lookBackFrom: number | undefined;
    const newMail = (found: Found) => {
      if (held !== undefined) return found.mail.filter((mail) => !held.has(mail.id));
      // Created is on Mailpit's clock, so the look-back starts from the Date of its first answer, or from ours without one
      const from = (lookBackFrom ??= (found.date ?? ctx.now().getTime()) - LOOK_BACK_MS);
      return found.mail.filter((mail) => mail.created >= from);
    };
    const code = await withTimeout(inbox, ctx.signal, (stop) => poll(ctx.http, inbox, newMail, stop));
    return code === undefined ? undefined : { kind: "value", value: code };
  },
};

function inboxOf(params: Readonly<Record<string, string>>): Inbox {
  const recipient = params["recipient"];
  if (recipient === undefined || recipient === "")
    throw new Error("otp-mailpit needs params.recipient, the address the code is mailed to");
  const timeoutSeconds = Number(params["timeoutSeconds"] ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)
    throw new Error("otp-mailpit params.timeoutSeconds is not a number of seconds");
  return {
    url: (params["url"] ?? DEFAULT_URL).replace(/\/+$/, ""),
    searchPath: params["searchPath"] ?? DEFAULT_SEARCH_PATH,
    messagePath: params["messagePath"] ?? DEFAULT_MESSAGE_PATH,
    recipient,
    pattern: new RegExp(params["pattern"] ?? DEFAULT_PATTERN),
    timeoutMs: timeoutSeconds * 1000,
  };
}

/** Runs `work` until it settles or the run aborts; undefined once the inbox's timeout passes first. */
async function withTimeout<T>(
  inbox: Inbox,
  run: AbortSignal,
  work: (stop: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const deadline = AbortSignal.timeout(inbox.timeoutMs);
  try {
    return await work(AbortSignal.any([run, deadline]));
  } catch (error) {
    if (deadline.aborted && !run.aborted) return undefined;
    throw error;
  }
}

async function poll(
  http: GuardedHttp,
  inbox: Inbox,
  newMail: (found: Found) => Mail[],
  stop: AbortSignal,
): Promise<string> {
  for (;;) {
    const code = await findCode(http, inbox, newMail, stop);
    if (code !== undefined) return code;
    await sleep(POLL_MS, undefined, { signal: stop });
  }
}

/** The code in the newest new mail that holds one. */
async function findCode(
  http: GuardedHttp,
  inbox: Inbox,
  newMail: (found: Found) => Mail[],
  stop: AbortSignal,
): Promise<string | undefined> {
  for (const mail of newMail(await search(http, inbox, stop))) {
    const text = textOf(
      (await getJson(http, new URL(`${inbox.url}${inbox.messagePath}/${encodeURIComponent(mail.id)}`), stop)).body,
    );
    const match = inbox.pattern.exec(text);
    if (match !== null) return match[1] ?? match[0];
  }
  return undefined;
}

async function search(http: GuardedHttp, inbox: Inbox, stop: AbortSignal): Promise<Found> {
  const url = new URL(`${inbox.url}${inbox.searchPath}`);
  url.searchParams.set("query", `to:"${inbox.recipient}"`);
  // Mailpit's to: search matches any address that contains the term, so joann@ also matches ann@
  const recipient = inbox.recipient.toLowerCase();
  const response = await getJson(http, url, stop);
  const mail = summaries(response.body)
    .filter((summary) => summary.To.some((to) => to.Address.toLowerCase() === recipient))
    .map((summary) => ({ id: summary.ID, created: Date.parse(summary.Created) }));
  const date = Date.parse(response.headers.get("date") ?? "");
  return { mail, date: Number.isNaN(date) ? undefined : date };
}

async function getJson(http: GuardedHttp, url: URL, stop: AbortSignal): Promise<HttpResponse> {
  const response = await http.send({
    method: "GET",
    url,
    headers: new Headers({ accept: "application/json" }),
    signal: stop,
  });
  // the query holds the recipient, so the message names only the path
  if (response.status !== 200)
    throw new Error(`Mailpit answered ${response.status} to GET ${url.origin}${url.pathname}`);
  return response;
}

interface MessageSummary {
  ID: string;
  /** RFC 3339, when Mailpit received the mail. */
  Created: string;
  To: { Address: string }[];
}

function summaries(body: unknown): MessageSummary[] {
  const messages = isRecord(body) ? body["messages"] : undefined;
  if (Array.isArray(messages) && messages.every(isSummary)) return messages;
  throw new Error("the Mailpit search answer has no messages list with ID, Created and To");
}

function isSummary(value: unknown): value is MessageSummary {
  return (
    isRecord(value) &&
    typeof value["ID"] === "string" &&
    typeof value["Created"] === "string" &&
    Array.isArray(value["To"]) &&
    value["To"].every((to) => isRecord(to) && typeof to["Address"] === "string")
  );
}

function textOf(body: unknown): string {
  const text = isRecord(body) ? body["Text"] : undefined;
  if (typeof text === "string") return text;
  throw new Error("the Mailpit message answer has no Text");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
