import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import {
  trackerHttp,
  trackerPath,
  TrackerRequestFailed,
  type TrackerHttp,
  type TrackerHttpOptions,
} from "../src/report/index.ts";

const EMAIL = "qa@example.test";
const TOKEN = "fake-token-4821";
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const AUTHORIZATION = `Basic ${BASIC}`;

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Route = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

const servers: Server[] = [];

/** Serves on 127.0.0.1, recording each request before the current route answers it. */
async function serve(): Promise<{ origin: string; seen: Seen[]; route: { current: Route } }> {
  const seen: Seen[] = [];
  const route = { current: ((_req, res) => json(res, 404, {})) as Route };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method ?? "",
        url: req.url ?? "/",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(request);
      route.current(req, res, request);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, route };
}

describe("trackerHttp", () => {
  let tracker: Awaited<ReturnType<typeof serve>>;
  let elsewhere: Awaited<ReturnType<typeof serve>>;
  let redactor: Redactor;
  let logs: string[];

  beforeAll(async () => {
    tracker = await serve();
    elsewhere = await serve();
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  beforeEach(() => {
    for (const server of [tracker, elsewhere]) {
      server.seen.length = 0;
      server.route.current = (_req, res) => json(res, 404, {});
    }
    redactor = new Redactor(defaultRedactionRules());
    logs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function client(base: string, options: Partial<TrackerHttpOptions> = {}): TrackerHttp {
    return trackerHttp({
      base: new URL(base),
      authorization: AUTHORIZATION,
      redactor,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
      ...options,
    });
  }

  function paths(): string[] {
    return tracker.seen.map((seen) => `${seen.method} ${seen.url}`);
  }

  it("refuses a base that is not https, except http on 127.0.0.1 or localhost with a port", () => {
    for (const base of ["http://tracker.example.test", "http://localhost/", "ftp://127.0.0.1:2121"]) {
      expect(() => client(base)).toThrow(
        `tracker base ${new URL(base).origin} is not https; http is only for 127.0.0.1 or localhost with a port`,
      );
    }
    for (const base of ["https://tracker.example.test", "http://localhost:8080", tracker.origin]) {
      expect(() => client(base)).not.toThrow();
    }
  });

  it("joins the path onto the base path and sends the credential, logging method and path only", async () => {
    tracker.route.current = (_req, res) => json(res, 200, { key: "DEMO-12", fields: { status: { name: "Done" } } });
    const http = client(`${tracker.origin}/ex/jira/c0ffee/`);

    const response = await http.send({
      method: "post",
      path: "/rest/api/3/issue/DEMO-12/comment",
      query: { expand: "renderedBody" },
      json: { body: "a comment" },
    });

    expect(response).toMatchObject({ status: 200, body: { key: "DEMO-12", fields: { status: { name: "Done" } } } });
    expect(tracker.seen).toEqual([
      {
        method: "POST",
        url: "/ex/jira/c0ffee/rest/api/3/issue/DEMO-12/comment?expand=renderedBody",
        authorization: AUTHORIZATION,
        contentType: "application/json",
        body: JSON.stringify({ body: "a comment" }),
      },
    ]);
    expect(logs).toEqual(["POST /rest/api/3/issue/DEMO-12/comment"]);
  });

  it("follows a redirect to the same origin, sending the method and body again for a 307", async () => {
    tracker.route.current = (req, res) =>
      req.url === "/moved"
        ? res.writeHead(307, { location: "/rest/api/3/issue" }).end()
        : json(res, 201, { key: "DEMO-901" });

    const response = await client(tracker.origin).send({ method: "POST", path: "/moved", json: { summary: "x" } });

    expect(response.body).toEqual({ key: "DEMO-901" });
    expect(tracker.seen.map(({ method, url, authorization, body }) => ({ method, url, authorization, body }))).toEqual([
      { method: "POST", url: "/moved", authorization: AUTHORIZATION, body: '{"summary":"x"}' },
      { method: "POST", url: "/rest/api/3/issue", authorization: AUTHORIZATION, body: '{"summary":"x"}' },
    ]);
    expect(logs).toEqual(["POST /moved", "POST /rest/api/3/issue"]);
  });

  it("refuses a redirect to another origin and never sends to it", async () => {
    tracker.route.current = (_req, res) => res.writeHead(302, { location: `${elsewhere.origin}/collect` }).end();

    await expect(client(tracker.origin).send({ method: "GET", path: "/away" })).rejects.toThrow(
      `GET /away redirected to ${elsewhere.origin}, which is not the tracker`,
    );
    expect(elsewhere.seen).toEqual([]);
  });

  it("stops after five redirects", async () => {
    tracker.route.current = (_req, res) => res.writeHead(302, { location: "/loop" }).end();

    await expect(client(tracker.origin).send({ method: "GET", path: "/loop" })).rejects.toThrow(
      "GET /loop redirected more than 5 times",
    );
    expect(tracker.seen).toHaveLength(6);
  });

  it("retries a 429 for any method, waiting for Retry-After", async () => {
    tracker.route.current = (_req, res) =>
      tracker.seen.length < 3 ? json(res, 429, {}, { "retry-after": "0" }) : json(res, 201, { id: "10001" });

    const response = await client(tracker.origin).send({ method: "POST", path: "/rest/api/3/issue/DEMO-12/comment" });

    expect(response.status).toBe(201);
    expect(paths()).toEqual(Array(3).fill("POST /rest/api/3/issue/DEMO-12/comment"));
    expect(logs.filter((line) => line.includes("retrying"))).toEqual(
      Array(2).fill("POST /rest/api/3/issue/DEMO-12/comment answered 429; retrying in 0 s"),
    );
  });

  it("retries a 503 only for GET, and gives up after four attempts", async () => {
    tracker.route.current = (_req, res) => json(res, 503, {}, { "retry-after": "0" });
    const http = client(tracker.origin);

    await expect(http.send({ method: "GET", path: "/rest/api/3/issue/DEMO-12" })).rejects.toMatchObject({
      name: "TrackerRequestFailed",
      status: 503,
      message: "GET /rest/api/3/issue/DEMO-12 answered 503",
    });
    await expect(http.send({ method: "PUT", path: "/rest/api/3/issue/DEMO-12" })).rejects.toMatchObject({
      status: 503,
    });
    expect(paths()).toEqual([...Array(4).fill("GET /rest/api/3/issue/DEMO-12"), "PUT /rest/api/3/issue/DEMO-12"]);
  });

  it("waits a backoff from 1 s with jitter when Retry-After is missing, and at most 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // the lowest jitter factor, 0.7
    vi.spyOn(Math, "random").mockReturnValue(0);
    const answers = [new Response(null, { status: 429 }), new Response(null, { status: 429 })];
    answers.push(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    let fetched = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetched += 1;
      return answers[fetched - 1] ?? new Response(null, { status: 204 });
    };

    const sent = client("https://tracker.example.test", { fetch }).send({ method: "GET", path: "/busy" });

    const fetchedAfter = async (ms: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(ms);
      return fetched;
    };
    expect([await fetchedAfter(699), await fetchedAfter(1)]).toEqual([1, 2]);
    expect([await fetchedAfter(1399), await fetchedAfter(1)]).toEqual([2, 3]);
    expect([await fetchedAfter(59_999), await fetchedAfter(1)]).toEqual([3, 4]);
    await expect(sent).resolves.toMatchObject({ status: 204 });
  });

  it("stops waiting when the signal aborts", async () => {
    tracker.route.current = (_req, res) => json(res, 429, {}, { "retry-after": "30" });
    const controller = new AbortController();
    const cancelled = new Error("run cancelled");

    const sent = client(tracker.origin, { signal: controller.signal }).send({ method: "GET", path: "/busy" });
    setTimeout(() => controller.abort(cancelled), 50);

    await expect(sent).rejects.toBe(cancelled);
    expect(tracker.seen).toHaveLength(1);
  });

  it("throws TrackerRequestFailed with the first error message from the body", async () => {
    tracker.route.current = (req, res) =>
      req.method === "GET"
        ? json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] })
        : json(res, 400, { errorMessages: [], errors: { issuetype: "The issue type selected is invalid." } });
    const http = client(tracker.origin);

    const missing = http.send({ method: "GET", path: "/rest/api/3/issue/DEMO-404" });
    await expect(missing).rejects.toBeInstanceOf(TrackerRequestFailed);
    await expect(missing).rejects.toMatchObject({
      status: 404,
      message:
        "GET /rest/api/3/issue/DEMO-404 answered 404: Issue does not exist or you do not have permission to see it.",
    });
    await expect(http.send({ method: "POST", path: "/rest/api/3/issue" })).rejects.toMatchObject({
      status: 400,
      message: "POST /rest/api/3/issue answered 400: The issue type selected is invalid.",
    });
  });

  it("says to check the token on a 401", async () => {
    tracker.route.current = (_req, res) =>
      json(res, 401, { errorMessages: ["Client must be authenticated to access this resource."] });

    await expect(client(tracker.origin).send({ method: "GET", path: "/rest/api/3/myself" })).rejects.toMatchObject({
      status: 401,
      message:
        "GET /rest/api/3/myself answered 401: Client must be authenticated to access this resource; " +
        "check that the API token has not expired, and for a scoped token set the tracker's api",
    });
  });

  it("masks the header, the bare base64 and the token in errors and logs", async () => {
    tracker.route.current = (req, res, seen) => {
      if (seen.url.startsWith("/retry") && tracker.seen.length === 1) return json(res, 429, {}, { "retry-after": "0" });
      json(res, 400, { errorMessages: [`refused ${req.headers.authorization} for ${EMAIL}:${TOKEN} (${BASIC})`] });
    };

    const error = await client(tracker.origin)
      .send({ method: "GET", path: trackerPath`/retry/${TOKEN}` })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TrackerRequestFailed);
    const shown = [(error as Error).message, ...logs].join("\n");
    for (const secret of [AUTHORIZATION, BASIC, TOKEN]) expect(shown).not.toContain(secret);
    expect(logs).toEqual([
      "GET /retry/[redacted]",
      "GET /retry/[redacted] answered 429; retrying in 0 s",
      "GET /retry/[redacted]",
    ]);
  });

  it("refuses a path with a . or .. segment, or one outside the base path, before sending", async () => {
    const http = client(`${tracker.origin}/ex/jira/c0ffee`);

    for (const [path, error] of [
      [trackerPath`/rest/api/3/issue/${".."}/comment`, "has a . or .. segment"],
      ["/rest/api/3/issue/%2e%2e/comment", "has a . or .. segment"],
      ["/rest/api/3\\..\\..\\admin", "has a . or .. segment"],
      ["/rest/api/3/issue/.\t./.\t./serverInfo", "has a . or .. segment"],
      ["rest/api/3/issue", "resolves outside the tracker base path /ex/jira/c0ffee"],
    ] as const) {
      await expect(http.send({ method: "GET", path })).rejects.toThrow(`GET ${path} ${error}`);
    }
    expect(tracker.seen).toEqual([]);
  });

  it("encodes each path parameter, so one parameter stays one segment", async () => {
    tracker.route.current = (_req, res) => json(res, 200, {});

    await client(tracker.origin).send({ method: "GET", path: trackerPath`/rest/api/3/issue/${"DEMO-12/../admin?x"}` });

    expect(paths()).toEqual(["GET /rest/api/3/issue/DEMO-12%2F..%2Fadmin%3Fx"]);
  });
});
