import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { bugLabel } from "@bazam/core/report";
import {
  startJiraStub,
  type JiraStub,
} from "../../packages/tracker-jira/test/support/jira-stub.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "jira-smoke.ts");
const EMAIL = "qa@example.test";
// Atlassian tokens hold '=', which the env file must keep
const TOKEN = "not-a-real=jira-token==";
// each run starts the CLI up to four times
const SLOW = 60_000;
const SEARCH = "/rest/api/3/search/jql";

interface ScriptRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** What a proxy answers in place of the stub: a status and a JSON body, or `hold` to never answer. */
type Intercept = (
  method: string,
  url: string,
) => { status: number; body: unknown } | "hold" | undefined;

let stub: JiraStub;
let dir: string;
let envFile: string;
let closers: (() => Promise<void>)[];

beforeEach(async () => {
  stub = await startJiraStub({
    email: EMAIL,
    token: TOKEN,
    issues: [{ key: "DEMO-1", status: "To Do" }],
  });
  dir = await mkdtemp(path.join(tmpdir(), "jira-smoke-test-"));
  // missing unless a test writes it, so a developer's own env file never reaches the script
  envFile = path.join(dir, ".jira-smoke.env");
  closers = [];
});

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

/** Starts the script with only `vars` among the JIRA_ variables, so the shell's own never reach it. */
function launch(
  vars: Record<string, string>,
  ...args: string[]
): { child: ChildProcess; done: Promise<ScriptRun> } {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("JIRA_"));
  const env = { ...Object.fromEntries(inherited), ...vars };
  const child = spawn(process.execPath, [SCRIPT, "--inputs", envFile, ...args], { env });
  const done = new Promise<ScriptRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function smoke(vars: Record<string, string>, ...args: string[]): Promise<ScriptRun> {
  return launch(vars, ...args).done;
}

function site(): Record<string, string> {
  return { JIRA_SMOKE_SITE: stub.site, JIRA_SMOKE_PROJECT: "DEMO", JIRA_SMOKE_TICKET: "DEMO-1" };
}

function lines(text: string): string[] {
  return text.trimEnd().split("\n");
}

/** Serves `listener` on 127.0.0.1 until the test ends and returns its `host:port`. */
async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A REST base in front of the stub that answers what `intercept` returns and forwards the rest. */
async function proxy(intercept: Intercept): Promise<string> {
  const host = await serve((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const answer = intercept(req.method ?? "GET", req.url ?? "/");
      if (answer === "hold") return;
      if (answer !== undefined) {
        res
          .writeHead(answer.status, { "content-type": "application/json" })
          .end(JSON.stringify(answer.body));
        return;
      }
      const headers = new Headers();
      for (const name of ["authorization", "accept", "content-type", "x-atlassian-token"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const forwarded = await fetch(`http://${stub.site}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      const type = forwarded.headers.get("content-type");
      res
        .writeHead(forwarded.status, type === null ? {} : { "content-type": type })
        .end(Buffer.from(await forwarded.arrayBuffer()));
    })().catch((error: unknown) => res.writeHead(502).end(String(error)));
  });
  return `http://${host}`;
}

/** Answers `status` to the `nth` search request; the failing run's own search is the first. */
function failSearch(nth: number, status: number): Intercept {
  let searches = 0;
  return (method, url) => {
    if (method !== "POST" || url !== SEARCH) return undefined;
    searches += 1;
    return searches === nth ? { status, body: { errorMessages: ["try again later"] } } : undefined;
  };
}

function comments(key: string): unknown[] {
  return stub.issues.get(key)?.comments ?? [];
}

describe("jira-smoke", () => {
  it(
    "comments on the ticket, files a linked bug, comments on it after the pass, posts the probe and moves nothing",
    async () => {
      // the environment wins over the file, and the file supplies what the environment leaves out
      await writeFile(
        envFile,
        `# smoke inputs\n\nJIRA_SMOKE_TICKET=DEMO-9\nJIRA_API_TOKEN="${TOKEN}"\n`,
      );
      const run = await smoke({ ...site(), JIRA_EMAIL: EMAIL });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout + run.stderr).not.toContain(TOKEN);
      expect(run.stdout + run.stderr).not.toContain(EMAIL);

      expect(stub.requests[0]).toMatchObject({
        method: "GET",
        path: "/rest/api/3/issue/DEMO-1",
        query: { fields: "status" },
      });
      const ticketComments = stub.issues.get("DEMO-1")?.comments ?? [];
      expect(ticketComments).toHaveLength(1);

      const bug = stub.issues.get("DEMO-2");
      const caseId = /^\[(SMOKE-JIRA\d{6}-\d{6})\] /.exec(bug?.summary ?? "")?.[1] ?? "";
      expect(caseId).not.toBe("");
      const create = stub.requests.find(
        (request) => request.method === "POST" && request.path === "/rest/api/3/issue",
      );
      expect(create?.body).toMatchObject({
        fields: {
          project: { key: "DEMO" },
          issuetype: { name: "Bug" },
          labels: [`${BRAND.markerPrefix}-smoke`, bugLabel(caseId)],
        },
      });
      expect(stub.links).toEqual([{ type: "Relates", inward: "DEMO-2", outward: "DEMO-1" }]);

      const [recovery, probe, ...others] = bug?.comments ?? [];
      expect(others).toEqual([]);
      expect(JSON.stringify(recovery?.body)).toContain('"table"');
      expect(probe?.body).toMatchObject({
        type: "doc",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "expand",
            content: [expect.objectContaining({ type: "paragraph" })],
          }),
        ]),
      });
      expect(stub.requests.filter((request) => request.path.endsWith("/transitions"))).toEqual([]);

      const browse = `http://${stub.site}/browse`;
      const out = lines(run.stdout);
      expect(out).toEqual(
        expect.arrayContaining([
          `ticket comment ${browse}/DEMO-1?focusedCommentId=${ticketComments[0]?.id}`,
          `bug DEMO-2 ${browse}/DEMO-2`,
          `recovery comment ${browse}/DEMO-2?focusedCommentId=${recovery?.id}`,
          `probe comment ${browse}/DEMO-2?focusedCommentId=${probe?.id}`,
        ]),
      );
      expect(out).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^the search found DEMO-2 after \d+\.\d s$/),
        ]),
      );
    },
    SLOW,
  );

  it(
    "names a bug filed before its link failed, for deletion, and skips the passing run and the probe",
    async () => {
      const api = await proxy((method, url) =>
        method === "POST" && url === "/rest/api/3/issueLink"
          ? { status: 403, body: { errorMessages: ["You do not have permission to link issues."] } }
          : undefined,
      );
      const run = await smoke({
        ...site(),
        JIRA_SMOKE_API: api,
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
      });
      expect(run.code, run.stderr).toBe(1);

      const out = lines(run.stdout);
      expect(out).toContain(`bug DEMO-2 http://${stub.site}/browse/DEMO-2`);
      const cleanup = out.find((line) => line.startsWith("Delete afterwards:"));
      expect(cleanup).toContain("the bug DEMO-2");
      expect(cleanup).toContain("the comment on DEMO-1");
      expect(stub.links).toEqual([]);
      expect(comments("DEMO-2")).toEqual([]);
    },
    SLOW,
  );

  it(
    "keeps searching for the new bug after an answer that may pass on the next try",
    async () => {
      // the script's first search is the second one
      const api = await proxy(failSearch(2, 503));
      const run = await smoke({
        ...site(),
        JIRA_SMOKE_API: api,
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
      });
      expect(run.code, run.stderr).toBe(0);
      expect(comments("DEMO-2")).toHaveLength(2);
    },
    SLOW,
  );

  it(
    "stops searching at an answer that will not pass and skips the passing run and the probe",
    async () => {
      const api = await proxy(failSearch(2, 400));
      const run = await smoke({
        ...site(),
        JIRA_SMOKE_API: api,
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `POST ${SEARCH} answered 400: try again later; skipped the passing run and the probe`,
      );
      expect(comments("DEMO-2")).toEqual([]);
    },
    SLOW,
  );

  it(
    "after Ctrl-C prints what to delete and removes its temporary project",
    async () => {
      let interrupt = (): void => {};
      let searches = 0;
      // Ctrl-C while the script's first search waits for its answer
      const api = await proxy((method, url) => {
        if (method !== "POST" || url !== SEARCH) return undefined;
        searches += 1;
        if (searches < 2) return undefined;
        interrupt();
        return "hold";
      });
      const temp = path.join(dir, "tmp");
      await mkdir(temp);
      const { child, done } = launch({
        ...site(),
        JIRA_SMOKE_API: api,
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
        TMPDIR: temp,
      });
      interrupt = () => child.kill("SIGINT");
      const run = await done;
      expect(run.code, run.stderr).toBe(1);
      expect(lines(run.stdout)).toContain(
        "Delete afterwards: the bug DEMO-2, which takes its comments with it, and the comment on DEMO-1.",
      );
      expect((await readdir(temp)).filter((name) => name.startsWith("jira-smoke-"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "stops with exit 2 before sending anything for an unusable input or a ticket it cannot read",
    async () => {
      // the later --inputs wins over the helper's
      const inRepo = await smoke(
        { ...site(), JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN },
        "--inputs",
        path.resolve(import.meta.dirname, "..", "..", ".jira-smoke.env"),
      );
      expect(inRepo.code).toBe(2);
      expect(inRepo.stderr).toContain("scripts/.jira-smoke.env");

      const missing = await smoke({ ...site(), JIRA_API_TOKEN: TOKEN });
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("JIRA_EMAIL");

      const outside = await smoke({
        ...site(),
        JIRA_SMOKE_TICKET: "OTHER-1",
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
      });
      expect(outside.code).toBe(2);
      expect(outside.stderr).toContain("OTHER-1 is not in project DEMO");

      // the Jira client takes only the scoped base, so the script refuses the site as a base
      const siteBase = { JIRA_SMOKE_API: "https://example.atlassian.net" };
      const api = await smoke({ ...site(), ...siteBase, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN });
      expect(api.code).toBe(2);
      expect(api.stderr).toContain("JIRA_SMOKE_API");
      const dryApi = await smoke(siteBase, "--dry-run");
      expect(dryApi.code).toBe(2);
      expect(dryApi.stderr).toContain("JIRA_SMOKE_API");
      expect(stub.requests).toEqual([]);

      const wrong = "wrong-jira-token";
      const refused = await smoke({ ...site(), JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: wrong });
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("401");
      expect(refused.stderr).toContain("JIRA_SMOKE_API");
      expect(refused.stdout + refused.stderr).not.toContain(wrong);

      // an https base other than the scoped one would get the credentials before the CLI refuses it
      const unscoped = await smoke({
        ...site(),
        JIRA_SMOKE_API: `https://${stub.site}/ex/not-scoped`,
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
      });
      expect(unscoped.code).toBe(2);
      expect(unscoped.stderr).toContain("JIRA_SMOKE_API");
      expect(unscoped.stderr).toContain("must be https://api.atlassian.com/ex/jira/<cloudId>");
      expect(stub.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /rest/api/3/issue/DEMO-1",
      ]);
    },
    SLOW,
  );

  it("masks the credentials in what it prints", async () => {
    const echo = await serve((req, res) => {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          errorMessages: [`echo ${TOKEN} ${EMAIL} ${req.headers.authorization ?? ""}`],
        }),
      );
    });
    const run = await smoke({
      JIRA_SMOKE_SITE: echo,
      JIRA_SMOKE_PROJECT: "DEMO",
      JIRA_SMOKE_TICKET: "DEMO-1",
      JIRA_EMAIL: EMAIL,
      JIRA_API_TOKEN: TOKEN,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("[redacted]");
    const printed = run.stdout + run.stderr;
    for (const secret of [TOKEN, EMAIL, Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")])
      expect(printed).not.toContain(secret);
  });

  it(
    "prints the plan with --dry-run without credentials, falling back to the example keys, and sends nothing",
    async () => {
      const run = await smoke({ JIRA_SMOKE_SITE: stub.site }, "--dry-run");
      expect(run.code, run.stderr).toBe(0);
      const caseId = /SMOKE-JIRA\d{6}-\d{6}/.exec(run.stdout)?.[0] ?? "";
      expect(lines(run.stdout)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`jira:DEMO-1 post the fail comment for ${caseId}`),
          expect.stringContaining(
            `jira:DEMO ${caseId}: comment on the open bug labelled ${bugLabel(caseId)}, or file`,
          ),
        ]),
      );
      expect(run.stdout).toContain("passing result");
      expect(run.stdout).toContain("expand");
      expect(stub.requests).toEqual([]);
    },
    SLOW,
  );
});
