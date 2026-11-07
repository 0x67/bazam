import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { mailpitResolver } from "../src/otp-mailpit.ts";
import { builtinKind, challenge, closeServers, context, NOW, serveJson } from "./support.ts";

const RECIPIENT = "customer@example.test";
const OTP_EMAIL = builtinKind("otp-email");

interface Mail {
  ID: string;
  to: string;
  /** Seconds after NOW on Mailpit's clock, negative for mail stamped before it. */
  at: number;
  Text: string;
}

function mail(ID: string, to: string, at: number, Text: string): Mail {
  return { ID, to, at, Text };
}

/** Mailpit's RFC 3339 form with nanoseconds. */
function created(at: number): string {
  return new Date(NOW.getTime() + at * 1000).toISOString().replace(/Z$/, "123456Z");
}

interface FakeMailpit {
  url: string;
  inbox: Mail[];
  searches: number;
  onSearch: () => void;
  /** No request gets an answer while set. */
  stalled: boolean;
  /** One promise per unanswered request, settled when its socket closes. */
  hung: Promise<void>[];
}

/**
 * Serves the search and message endpoints under `prefix` the way Mailpit v1.33.0 does: a `to:` search matches
 * every address that contains the term in any case, newest first.
 */
async function startMailpit(inbox: Mail[] = [], prefix = "/api/v1"): Promise<FakeMailpit> {
  const mailpit: FakeMailpit = { url: "", inbox, searches: 0, onSearch: () => {}, stalled: false, hung: [] };
  mailpit.url = await serveJson((url, req) => {
    if (mailpit.stalled) {
      mailpit.hung.push(new Promise((closed) => req.socket.once("close", () => closed())));
      return undefined;
    }
    if (url.pathname === `${prefix}/search`) {
      mailpit.searches += 1;
      mailpit.onSearch();
      const term = /^to:"(.+)"$/.exec(url.searchParams.get("query") ?? "")?.[1]?.toLowerCase();
      if (term === undefined) return { status: 400, body: { error: "expected a to: query" } };
      const found = mailpit.inbox.filter((message) => message.to.toLowerCase().includes(term)).sort((a, b) => b.at - a.at);
      const messages = found.map((message) => ({ ID: message.ID, Created: created(message.at), To: [{ Name: "", Address: message.to }] }));
      return { status: 200, body: { messages } };
    }
    const message = mailpit.inbox.find((candidate) => url.pathname === `${prefix}/message/${candidate.ID}`);
    return message === undefined ? { status: 404 } : { status: 200, body: { ID: message.ID, Text: message.Text } };
  });
  return mailpit;
}

/** Arms, runs `trigger` where the app would send its mail, then resolves. */
async function signIn(params: Record<string, string>, trigger: () => void = () => {}) {
  const request = challenge("otp-email", params);
  const ctx = context();
  await mailpitResolver.arm?.(request, ctx);
  trigger();
  return mailpitResolver.resolve(request, ctx, OTP_EMAIL);
}

describe("mailpitResolver", () => {
  afterEach(closeServers);

  it("returns the code from the newest mail to the recipient that arrived after arm", async () => {
    const mailpit = await startMailpit([mail("old", RECIPIENT, -5, "Your sign-in code is 111111")]);
    const answer = await signIn({ url: mailpit.url, recipient: RECIPIENT }, () =>
      mailpit.inbox.push(
        mail("first", RECIPIENT, 1, "Your sign-in code is 333333"),
        mail("other", "someone@example.test", 3, "Your sign-in code is 999999"),
        mail("new", RECIPIENT, 2, "Your sign-in code is 222222"),
      ),
    );
    expect(answer).toEqual({ kind: "value", value: "222222" });
  });

  it("matches the whole recipient address in any case and skips addresses that contain it", async () => {
    const mailpit = await startMailpit();
    const answer = await signIn({ url: mailpit.url, recipient: RECIPIENT }, () =>
      mailpit.inbox.push(
        mail("mine", "Customer@Example.test", 1, "Your sign-in code is 222222"),
        mail("theirs", `vip.${RECIPIENT}`, 2, "Your sign-in code is 999999"),
      ),
    );
    expect(answer).toEqual({ kind: "value", value: "222222" });
  });

  it("polls until a mail arrives after arm", async () => {
    const mailpit = await startMailpit([mail("old", RECIPIENT, -5, "Your sign-in code is 111111")]);
    // arm searches once, so the mail lands on the second poll
    mailpit.onSearch = () => {
      if (mailpit.searches === 3) mailpit.inbox.push(mail("new", RECIPIENT, 1, "Your sign-in code is 222222"));
    };
    expect(await signIn({ url: mailpit.url, recipient: RECIPIENT })).toEqual({ kind: "value", value: "222222" });
    expect(mailpit.searches).toBe(3);
  });

  it("takes mail that arrives after arm even when Mailpit stamps it before arm", async () => {
    const mailpit = await startMailpit();
    const params = { url: mailpit.url, recipient: RECIPIENT, timeoutSeconds: "0.5" };
    const answer = await signIn(params, () => mailpit.inbox.push(mail("new", RECIPIENT, -2, "Your sign-in code is 222222")));
    expect(answer).toEqual({ kind: "value", value: "222222" });
  });

  it("returns undefined at the timeout when only mail from before arm is there, even if Mailpit stamps it after arm", async () => {
    const mailpit = await startMailpit([mail("old", RECIPIENT, 3, "Your sign-in code is 111111")]);
    expect(await signIn({ url: mailpit.url, recipient: RECIPIENT, timeoutSeconds: "0.3" })).toBeUndefined();
  });

  it("returns the first capture of params.pattern", async () => {
    const mailpit = await startMailpit();
    const params = { url: mailpit.url, recipient: RECIPIENT, pattern: "Use ([A-Z0-9]{6})" };
    const answer = await signIn(params, () => mailpit.inbox.push(mail("new", RECIPIENT, 1, "Use A7K9Q2 to sign in. Reference 123456.")));
    expect(answer).toEqual({ kind: "value", value: "A7K9Q2" });
  });

  it("looks back a short window when arm was skipped", async () => {
    const mailpit = await startMailpit([mail("stale", RECIPIENT, -300, "Your sign-in code is 444444")]);
    const params = { url: mailpit.url, recipient: RECIPIENT, timeoutSeconds: "0.2" };
    expect(await mailpitResolver.resolve(challenge("otp-email", params), context(), OTP_EMAIL)).toBeUndefined();

    mailpit.inbox.push(mail("recent", RECIPIENT, -10, "Your sign-in code is 333333"));
    const answer = await mailpitResolver.resolve(challenge("otp-email", params), context(), OTP_EMAIL);
    expect(answer).toEqual({ kind: "value", value: "333333" });
  });

  it("reads the API under the base URL and paths the params give", async () => {
    const mailpit = await startMailpit([], "/mail/api/v2");
    const params = { url: `${mailpit.url}/mail/`, searchPath: "/api/v2/search", messagePath: "/api/v2/message", recipient: RECIPIENT };
    const answer = await signIn(params, () => mailpit.inbox.push(mail("new", RECIPIENT, 1, "Your sign-in code is 222222")));
    expect(answer).toEqual({ kind: "value", value: "222222" });
  });

  it("fails with the status and path but not the recipient when Mailpit answers an error", async () => {
    const url = await serveJson(() => ({ status: 500 }));
    await expect(signIn({ url, recipient: RECIPIENT })).rejects.toMatchObject({
      message: `Mailpit answered 500 to GET ${url}/api/v1/search`,
    });
  });

  it("fails arm when Mailpit does not answer within the timeout", async () => {
    const mailpit = await startMailpit();
    mailpit.stalled = true;
    const request = challenge("otp-email", { url: mailpit.url, recipient: RECIPIENT, timeoutSeconds: "0.2" });
    await expect(mailpitResolver.arm?.(request, context())).rejects.toThrow("Mailpit did not answer within 0.2 s");
  });

  it("returns undefined at the timeout while a Mailpit request hangs", async () => {
    const mailpit = await startMailpit();
    const params = { url: mailpit.url, recipient: RECIPIENT, timeoutSeconds: "0.3" };
    expect(await signIn(params, () => (mailpit.stalled = true))).toBeUndefined();
  });

  it("closes the hanging Mailpit request when resolve times out", async () => {
    const mailpit = await startMailpit();
    const params = { url: mailpit.url, recipient: RECIPIENT, timeoutSeconds: "0.3" };
    expect(await signIn(params, () => (mailpit.stalled = true))).toBeUndefined();
    expect(mailpit.hung).toHaveLength(1);
    const closed = await Promise.race([mailpit.hung[0]!.then(() => "closed"), sleep(1000, "still open")]);
    expect(closed).toBe("closed");
  });

  it("stops polling when the run aborts", async () => {
    const mailpit = await startMailpit();
    const run = new AbortController();
    const params = { url: mailpit.url, recipient: RECIPIENT };
    const answer = mailpitResolver.resolve(challenge("otp-email", params), context({ signal: run.signal }), OTP_EMAIL);
    setTimeout(() => run.abort(), 100);
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops when the run aborts while a Mailpit request hangs", async () => {
    const mailpit = await startMailpit();
    mailpit.stalled = true;
    const run = new AbortController();
    const params = { url: mailpit.url, recipient: RECIPIENT };
    const answer = mailpitResolver.resolve(challenge("otp-email", params), context({ signal: run.signal }), OTP_EMAIL);
    setTimeout(() => run.abort(), 100);
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
  });
});
