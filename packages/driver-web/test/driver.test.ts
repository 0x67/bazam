import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { StorageState } from "@bazam/core/auth";
import { ConnectionFailed, type DriverSession } from "@bazam/core/driver";
import { HostNotAllowed, type Environment } from "@bazam/core/env";
import { CaseBlocked } from "@bazam/core/run";
import { Redactor, defaultRedactionRules } from "@bazam/core/redact";
import type { CheckRecord, EvidenceStore } from "@bazam/core/result";
import { unzipSync } from "fflate";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { playwrightDriver, type WebSession } from "../src/driver.ts";
import {
  demoEnv,
  ENGINES,
  html,
  launch,
  newEvidence,
  runSteps,
  runUntilThrown,
  startSite,
  stepContext,
  tempDir,
  type Handler,
  type Site,
} from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CASE_ID = "WEB-ORDER-001";
const BEARER = "Bearer fake-bearer-7f3a9c";
const API_KEY = "fake-api-key-5b1e";
const BASIC = { username: "ops", password: "fake-basic-password" };
const BASIC_AUTHORIZATION = `Basic ${Buffer.from("ops:fake-basic-password").toString("base64")}`;
const PAGE_BEARER = "Bearer fake-page-token-2d8e";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Answers 401 with a Basic challenge unless the request carries the fake basic credentials. */
function gated(handler: Handler): Handler {
  return (request, response, current) => {
    if (request.headers.authorization === BASIC_AUTHORIZATION)
      return handler(request, response, current);
    response.writeHead(401, {
      "www-authenticate": 'Basic realm="staging"',
      "content-type": "text/html",
    });
    response.end("<h1>Unauthorized</h1>");
  };
}

const HOME = `
<h1>Orders</h1>
<label>Code <input data-testid="code" data-qa="order-code"></label>
<label for="country">Country</label>
<select id="country" data-testid="country"><option value="id">Indonesia</option><option value="sg">Singapore</option></select>
<button type="button" onclick="document.querySelector('#out').textContent = 'Saved ' + document.querySelector('[data-testid=code]').value + ' in ' + document.querySelector('#country').value">Save</button>
<input data-testid="search" onkeydown="if (event.key === 'Enter') document.querySelector('#out').textContent = 'Searched ' + this.value">
<p id="out" data-testid="out"></p>
<a href="/next">Next</a>
<a href="{elsewhere}/away">Away</a>
<a href="/bounce">Bounce</a>
<a href="{elsewhere}/direct" target="_blank">Help</a>
<button type="button" onclick="window.open('/bounce')">Popup</button>
<button type="button" onclick="setTimeout(function () { location.href = '{elsewhere}/away' }, 200)">Pay</button>
<img src="{elsewhere}/pixel.png" alt="">
`;

// the page calls its API with a token of its own, once directly and once through a same-origin redirect
const CLIENT = `
<p data-testid="calls">pending</p>
<script>
  (async function () {
    var headers = { Authorization: "${PAGE_BEARER}" };
    var direct = await fetch("/api/orders?direct", { headers: headers });
    var moved = await fetch("/api/moved", { headers: headers });
    document.querySelector("[data-testid=calls]").textContent = "orders " + direct.status + " " + moved.status;
  })();
</script>
`;

const LIVE = `
<p data-testid="live">connecting</p>
<script>
  var socket = new WebSocket(location.origin.replace("http", "ws") + "/live");
  socket.onopen = function () { document.querySelector("[data-testid=live]").textContent = "open"; };
</script>
`;

// each call shows its number and status, so a step can wait for the call it made
const ACCOUNT = `
<p data-testid="calls">none</p>
<button type="button" data-testid="fetch" onclick="call(fetch('/api/account?token=fake-query-token-4c1d'))">Fetch</button>
<button type="button" data-testid="xhr" onclick="call(xhr('/api/account'))">XHR</button>
<button type="button" data-testid="gated" onclick="call(fetch('/gated/api'))">Gated</button>
<button type="button" data-testid="elsewhere" onclick="call(fetch('{elsewhere}/api/account', { mode: 'no-cors' }))">Elsewhere</button>
<script>
  var calls = 0;
  function call(answer) {
    var number = ++calls;
    answer.then(function (response) {
      document.querySelector("[data-testid=calls]").textContent = "call " + number + ": " + response.status;
    });
  }
  function xhr(url) {
    return new Promise(function (done) {
      var request = new XMLHttpRequest();
      request.onload = function () { done(request); };
      request.open("GET", url);
      request.send();
    });
  }
</script>
`;

function sessionCookie(value: string): StorageState {
  return {
    cookies: [
      {
        name: "sid",
        value,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

/** A port on 127.0.0.1 that was just free, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

describe.each(ENGINES)("playwrightDriver on %s", (engine) => {
  let site: Site;
  let env: Environment;
  let root: string;
  let session: WebSession | undefined;
  // the session cookie value the account API takes
  let accepted: string;

  beforeAll(async () => {
    site = await startSite({
      "/": html(HOME),
      "/next": html("<h1>Next</h1>"),
      "/whoami": (request, response) => response.end(`cookie: ${request.headers.cookie ?? "none"}`),
      "/bounce": (_request, response, current) => {
        response.writeHead(302, { location: `${current.elsewhere}/landing` });
        response.end();
      },
      "/pixel.png": (_request, response) => response.end(),
      "/dropped": (request) => request.socket.destroy(),
      "/credentialed": html('<img src="/hop" alt="">'),
      "/hop": (_request, response, current) => {
        response.writeHead(302, { location: `${current.elsewhere}/third` });
        response.end();
      },
      "/card": html(
        '<p data-testid="card" style="font-size: 32px">4242 4242 4242 4242</p><p>Total 12.00</p>',
      ),
      "/order-form": html(
        '<form method="post" action="/orders"><input name="sku" value="A-100"><button>Place order</button></form>',
      ),
      "/orders": (_request, response) => {
        response.writeHead(303, { location: "/receipt" });
        response.end();
      },
      "/receipt": (request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(`<p data-testid="receipt">Receipt by ${request.method}</p>`);
      },
      "/gated/start": gated((_request, response) => {
        response.writeHead(302, { location: "/gated/landing" });
        response.end();
      }),
      "/gated/landing": gated(html("<h1>Landing</h1>")),
      // browsers refuse a cross-origin image's challenge on their own, while a frame's they would answer
      "/gated/gallery": gated(
        html(
          '<h1>Gallery</h1><img src="{elsewhere}/gated/pixel.png" alt=""><iframe src="{elsewhere}/gated/landing"></iframe>',
        ),
      ),
      "/gated/pixel.png": gated((_request, response) => response.end()),
      "/client": html(CLIENT),
      "/api/orders": (request, response) => {
        response.writeHead(request.headers.authorization === PAGE_BEARER ? 200 : 401);
        response.end();
      },
      "/api/moved": (_request, response) => {
        response.writeHead(307, { location: "/api/orders?moved" });
        response.end();
      },
      "/account": html(ACCOUNT),
      "/api/account": (request, response) => {
        response.writeHead(request.headers.cookie === `sid=${accepted}` ? 200 : 401);
        response.end();
      },
      "/gated/api": gated((_request, response) => response.end()),
      "/denied": (_request, response) => {
        response.writeHead(401, { "content-type": "text/html" });
        response.end("<h1>Denied</h1>");
      },
    });
    env = demoEnv();
  });

  afterAll(() => site.close());

  beforeEach(async () => {
    root = await tempDir();
    site.requests.length = 0;
    accepted = "fake-session-1";
  });

  afterEach(async () => {
    await session?.close({ status: "pass", evidence: newEvidence(root, CASE_ID) });
    session = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function open(
    options: { settings?: Record<string, string>; redactor?: Redactor } = {},
  ): Promise<{ session: WebSession; evidence: EvidenceStore }> {
    session = await launch(engine, { env, runDir: join(root, "runs"), ...options });
    return { session, evidence: newEvidence(join(root, "runs"), CASE_ID) };
  }

  function recorded(evidence: EvidenceStore): () => CheckRecord[] {
    const record = vi.spyOn(evidence, "record");
    return () => record.mock.calls.map(([check]) => check);
  }

  it("runs open, fill, select, tap, press, wait and expect, filling placeholders in each payload", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    const ctx = stepContext(session, { env, evidence, root, values: { code: "A-100" } });

    await runSteps(ctx, [
      { open: `${site.origin}/` },
      { fill: { field: { id: "code" }, value: "${case.code}" } },
      { select: { field: { id: "country" }, option: "sg" } },
      { tap: { role: "button", name: "Save" } },
      { expect: { text: { field: { id: "out" }, equals: "Saved ${case.code} in sg" } } },
      { fill: { field: { id: "search" }, value: "shoes" } },
      { press: { key: "Enter", field: { id: "search" } } },
      { wait: { for: { text: "Searched shoes" } } },
      { expect: { visible: { css: "#out" } } },
      { tap: { text: "Next" } },
      { expect: { url: `${site.origin}/*` } },
    ]);

    expect(checks()).toEqual([
      {
        name: 'text of id=out equals "Saved ${case.code} in sg"',
        kind: "ui",
        expected: { equals: "Saved A-100 in sg" },
        observed: "Saved A-100 in sg",
        ok: true,
      },
      {
        name: "css=#out is visible",
        kind: "ui",
        expected: "visible",
        observed: "visible",
        ok: true,
      },
      {
        name: `URL matches ${site.origin}/*`,
        kind: "ui",
        expected: `${site.origin}/*`,
        observed: `${site.origin}/next`,
        ok: true,
      },
    ]);
  });

  it("matches { id } on the test id attribute the target names", async () => {
    const { session, evidence } = await open({ settings: { testIdAttribute: "data-qa" } });
    const ctx = stepContext(session, { env, evidence, root });

    await runSteps(ctx, [
      { open: `${site.origin}/` },
      { fill: { field: { id: "order-code" }, value: "B-200" } },
    ]);

    const page = await (await session.contextFor(undefined)).page();
    expect(await page.locator("[data-testid=code]").inputValue()).toBe("B-200");
  });

  it("attaches a screenshot under the step's name", async () => {
    const { session, evidence } = await open();
    const ctx = stepContext(session, { env, evidence, root });

    await runSteps(ctx, [{ open: `${site.origin}/` }, { screenshot: { name: "order form" } }]);

    const png = await readFile(join(root, "runs", CASE_ID, "01-order-form.png"));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("masks the elements the redactor's screenshot selectors match", async () => {
    const card = "[data-testid=card]";
    const { session, evidence } = await open({
      redactor: new Redactor({ ...defaultRedactionRules(), screenshotSelectors: [card] }),
    });

    await runSteps(stepContext(session, { env, evidence, root }), [
      { open: `${site.origin}/card` },
      { screenshot: { name: "card" } },
    ]);

    const png = await readFile(join(root, "runs", CASE_ID, "01-card.png"));
    const page = await (await session.contextFor(undefined)).page();
    expect(png.equals(await page.screenshot({ mask: [page.locator(card)] }))).toBe(true);
    expect(png.equals(await page.screenshot())).toBe(false);
  });

  it("gives each identity its own context and runs steps that name none in an anonymous one", async () => {
    const { session, evidence } = await open();
    const customer = await session.browserFor("customer");
    await customer.loadStorageState({
      cookies: [
        {
          name: "sid",
          value: "fake-customer-session",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/whoami?as=customer` },
    ]);
    await runSteps(stepContext(session, { env, evidence, root, identity: "agent" }), [
      { open: `${site.origin}/whoami?as=agent` },
    ]);
    await runSteps(stepContext(session, { env, evidence, root }), [
      { open: `${site.origin}/whoami?as=nobody` },
    ]);

    const cookies = Object.fromEntries(
      site.requests.map((request) => [request.path, request.headers.cookie ?? "none"]),
    );
    expect(cookies).toEqual({
      "/whoami?as=customer": "sid=fake-customer-session",
      "/whoami?as=agent": "none",
      "/whoami?as=nobody": "none",
    });
  });

  it("sends extra headers to allowlisted hosts and not to subresources elsewhere", async () => {
    const { session, evidence } = await open();
    await (await session.browserFor("customer")).setExtraHeaders({ Authorization: BEARER });

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/` },
      { wait: { ms: 300 } },
    ]);

    const sent = site.requests.map((request) => [
      request.host.split(":")[0],
      request.path,
      request.headers.authorization ?? "none",
    ]);
    expect(sent).toContainEqual(["127.0.0.1", "/", BEARER]);
    expect(sent).toContainEqual(["localhost", "/pixel.png", "none"]);
  });

  it("refuses to open a host outside the env's allowlist", async () => {
    const { session, evidence } = await open();

    const refused = runSteps(stepContext(session, { env, evidence, root }), [
      { open: `${site.elsewhere}/` },
    ]);

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
  });

  it("throws ConnectionFailed, naming the URL without its query, when nothing listens where it opens", async () => {
    const { session, evidence } = await open();
    const port = await closedPort();

    const refused = runSteps(stepContext(session, { env, evidence, root }), [
      { open: `http://127.0.0.1:${port}/home?code=fake-code` },
    ]);

    await expect(refused).rejects.toThrow(
      new ConnectionFailed(
        `GET http://127.0.0.1:${port}/home`,
        `connect ECONNREFUSED 127.0.0.1:${port}`,
        {
          host: "127.0.0.1",
        },
      ),
    );
    await expect(refused).rejects.toMatchObject({ host: "127.0.0.1" });
  });

  it("throws the browser's own error when the server drops a connection it accepted", async () => {
    const { session, evidence } = await open();

    const dropped = runSteps(stepContext(session, { env, evidence, root }), [
      { open: `${site.origin}/dropped` },
    ]);

    await expect(dropped).rejects.toThrow();
    await expect(dropped).rejects.not.toBeInstanceOf(ConnectionFailed);
  });

  it("blocks the case when a web step runs in a session of another driver", async () => {
    const { evidence } = await open();
    const foreign = { close: async () => {} } as unknown as DriverSession;

    const refused = runSteps(stepContext(foreign, { env, evidence, root }), [
      { open: `${site.origin}/` },
    ]);

    await expect(refused).rejects.toBeInstanceOf(CaseBlocked);
  });

  it("blocks when a link takes the page outside the allowlist", async () => {
    const { session, evidence } = await open();
    const ctx = stepContext(session, { env, evidence, root });
    await runSteps(ctx, [{ open: `${site.origin}/` }]);

    const refused = runSteps(ctx, [{ tap: { text: "Away" } }, { wait: { ms: 300 } }]);

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
    expect(site.requests.map((request) => request.path)).not.toContain("/away");
  });

  it("blocks when a redirect takes the page outside the allowlist", async () => {
    const { session, evidence } = await open();
    const ctx = stepContext(session, { env, evidence, root });
    await runSteps(ctx, [{ open: `${site.origin}/` }]);

    const refused = runSteps(ctx, [{ tap: { text: "Bounce" } }, { wait: { ms: 300 } }]);

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
  });

  it("blocks when a popup opens on a host outside the allowlist", async () => {
    const { session, evidence } = await open();
    const ctx = stepContext(session, { env, evidence, root });
    await runSteps(ctx, [{ open: `${site.origin}/` }]);

    const refused = runUntilThrown(ctx, [{ tap: { text: "Help" } }]);

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
    expect(site.requests.map((request) => request.path)).not.toContain("/direct");
  });

  it("blocks when a popup's first load redirects outside the allowlist", async () => {
    const { session, evidence } = await open();
    const ctx = stepContext(session, { env, evidence, root });
    await runSteps(ctx, [{ open: `${site.origin}/` }]);

    const refused = runUntilThrown(ctx, [{ tap: { role: "button", name: "Popup" } }]);

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
  });

  it("sends no extra header along a redirect, so a host outside the allowlist never gets one", async () => {
    const { session, evidence } = await open();
    await (
      await session.browserFor("customer")
    ).setExtraHeaders({ Authorization: BEARER, "X-Api-Key": API_KEY });
    const ctx = stepContext(session, { env, evidence, root, identity: "customer" });

    await runSteps(ctx, [{ open: `${site.origin}/credentialed` }, { wait: { ms: 300 } }]);
    const refused = runSteps(ctx, [{ open: `${site.origin}/bounce` }]);

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
    const elsewhere = site.requests.filter((request) => request.host.startsWith("localhost:"));
    expect(elsewhere.map((request) => request.path)).toEqual(
      expect.arrayContaining(["/third", "/landing"]),
    );
    expect(
      elsewhere.filter(
        (request) =>
          request.headers.authorization !== undefined || request.headers["x-api-key"] !== undefined,
      ),
    ).toEqual([]);
  });

  it("follows the redirect after a form post as a GET when the request carries extra headers", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    await (await session.browserFor("customer")).setExtraHeaders({ Authorization: BEARER });

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/order-form` },
      { tap: { role: "button", name: "Place order" } },
      { expect: { text: { field: { id: "receipt" }, equals: "Receipt by GET" } } },
    ]);

    expect(checks().map((check) => [check.observed, check.ok])).toEqual([["Receipt by GET", true]]);
    expect(site.requests.find((request) => request.path === "/orders")?.headers.authorization).toBe(
      BEARER,
    );
  });

  it("answers a basic auth challenge with the identity's credentials through a redirect", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    await (await session.browserFor("customer")).setHttpCredentials(BASIC);

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/gated/start` },
      { expect: { text: { field: { css: "h1" }, equals: "Landing" } } },
    ]);

    expect(checks().map((check) => [check.observed, check.ok])).toEqual([["Landing", true]]);
    const landing = site.requests.filter((request) => request.path === "/gated/landing");
    expect(landing.map((request) => request.headers.authorization)).toContain(BASIC_AUTHORIZATION);
  });

  // Chromium and Firefox answer the 401 challenge on any port, so they keep sending the first request without credentials
  it.skipIf(engine !== "webkit")(
    "sends basic credentials with the first request on WebKit, before any 401 challenge",
    async () => {
      const { session, evidence } = await open();
      await (await session.browserFor("customer")).setHttpCredentials(BASIC);

      await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
        { open: `${site.origin}/gated/start` },
        { expect: { text: { field: { css: "h1" }, equals: "Landing" } } },
      ]);

      const gated = site.requests.filter((request) => request.path.startsWith("/gated/"));
      expect(gated.map((request) => [request.path, request.headers.authorization])).toEqual([
        ["/gated/start", BASIC_AUTHORIZATION],
        ["/gated/landing", BASIC_AUTHORIZATION],
      ]);
    },
  );

  it.each([
    ["basic credentials", {}],
    ["basic credentials and extra headers", { "X-Api-Key": API_KEY }],
  ])(
    "keeps the Authorization header a page sets itself on requests to an allowlisted host, with %s",
    async (_mode, headers) => {
      const { session, evidence } = await open();
      const checks = recorded(evidence);
      const browser = await session.browserFor("customer");
      if (Object.keys(headers).length > 0) await browser.setExtraHeaders(headers);
      await browser.setHttpCredentials(BASIC);

      await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
        { open: `${site.origin}/client` },
        { expect: { text: { field: { id: "calls" }, equals: "orders 200 200" } } },
      ]);

      expect(checks().map((check) => [check.observed, check.ok])).toEqual([
        ["orders 200 200", true],
      ]);
      const api = site.requests.filter((request) => request.path.startsWith("/api/"));
      expect(api.map((request) => [request.path, request.headers.authorization])).toEqual([
        ["/api/orders?direct", PAGE_BEARER],
        ["/api/moved", PAGE_BEARER],
        ["/api/orders?moved", PAGE_BEARER],
      ]);
    },
  );

  // WebKit on Linux leaves the handshake unanswered even on a non-default port, and a handshake never reaches a
  // route where the driver could add the header itself
  it.skipIf(engine === "webkit" && process.platform === "linux")(
    "answers a basic auth challenge on a WebSocket handshake to an allowlisted host",
    async () => {
      const sockets = new Set<Duplex>();
      const page = gated(html(LIVE));
      const server = createHttpServer((request, response) => page(request, response, site));
      server.on("upgrade", (request, socket: Duplex) => {
        socket.on("error", () => {});
        sockets.add(socket);
        if (request.headers.authorization !== BASIC_AUTHORIZATION) {
          socket.end(
            'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="staging"\r\nContent-Length: 0\r\n\r\n',
          );
          return;
        }
        const accept = createHash("sha1")
          .update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const { port } = server.address() as AddressInfo;
      try {
        const { session, evidence } = await open();
        const checks = recorded(evidence);
        await (await session.browserFor("customer")).setHttpCredentials(BASIC);

        await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
          { open: `http://127.0.0.1:${port}/live` },
          { expect: { text: { field: { id: "live" }, equals: "open" } } },
        ]);

        expect(checks().map((check) => [check.observed, check.ok])).toEqual([["open", true]]);
      } finally {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    },
  );

  it("never answers a basic auth challenge from a host outside the allowlist", async () => {
    const { session, evidence } = await open();
    await (await session.browserFor("customer")).setHttpCredentials(BASIC);

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/gated/gallery` },
      { wait: { ms: 300 } },
    ]);

    const gallery = site.requests.filter((request) => request.path === "/gated/gallery");
    expect(gallery.map((request) => request.headers.authorization)).toContain(BASIC_AUTHORIZATION);
    const elsewhere = site.requests.filter((request) => request.host.startsWith("localhost:"));
    expect(elsewhere.map((request) => request.path)).toEqual(
      expect.arrayContaining(["/gated/pixel.png", "/gated/landing"]),
    );
    expect(elsewhere.filter((request) => request.headers.authorization !== undefined)).toEqual([]);
  });

  it("shows the 401 page in a context without credentials while another identity has them", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    await (await session.browserFor("customer")).setHttpCredentials(BASIC);

    await runSteps(stepContext(session, { env, evidence, root }), [
      { open: `${site.origin}/gated/start` },
      { expect: { text: { field: { css: "h1" }, equals: "Unauthorized" } } },
    ]);

    expect(checks().map((check) => [check.observed, check.ok])).toEqual([["Unauthorized", true]]);
    expect(site.requests.filter((request) => request.headers.authorization !== undefined)).toEqual(
      [],
    );
  });

  it("recovers after the page's 401 when the session cookie expires mid-case, and the next request passes", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    const browser = await session.browserFor("customer");
    await browser.loadStorageState(sessionCookie("fake-session-1"));
    const origins: string[] = [];
    let recovery: Promise<void> | undefined;
    // what the case run does after a 401: apply a new credential to the context
    browser.onUnauthorized?.((origin) => {
      origins.push(origin);
      recovery ??= browser.loadStorageState(sessionCookie("fake-session-2"));
    });
    const ctx = stepContext(session, { env, evidence, root, identity: "customer" });
    await runSteps(ctx, [
      { open: `${site.origin}/account` },
      { tap: { id: "fetch" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 1: 200" } } },
    ]);

    accepted = "fake-session-2";
    await runSteps(ctx, [
      { tap: { id: "fetch" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 2: 401" } } },
    ]);
    await vi.waitFor(() => expect(recovery).toBeDefined());
    await recovery;
    await runSteps(ctx, [
      { tap: { id: "xhr" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 3: 200" } } },
    ]);

    expect(checks().map((check) => [check.observed, check.ok])).toEqual([
      ["call 1: 200", true],
      ["call 2: 401", true],
      ["call 3: 200", true],
    ]);
    // the request carried a token in its query, and only the origin is reported
    expect(origins).toEqual([site.origin]);
  });

  it("reports a 401 only for fetch and XHR requests to allowlisted hosts", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    const origins: string[] = [];
    (await session.browserFor("customer")).onUnauthorized?.((origin) => origins.push(origin));
    const ctx = stepContext(session, { env, evidence, root, identity: "customer" });

    await runSteps(ctx, [
      { open: `${site.origin}/denied` },
      { open: `${site.origin}/account` },
      { tap: { id: "elsewhere" } },
      { expect: { text: { field: { id: "calls" }, contains: "call 1:" } } },
      { tap: { id: "xhr" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 2: 401" } } },
      { tap: { id: "fetch" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 3: 401" } } },
    ]);
    await vi.waitFor(() => expect(origins).toHaveLength(2));

    expect(checks().every((check) => check.ok)).toBe(true);
    expect(site.requests.map((request) => [request.host.split(":")[0], request.path])).toEqual(
      expect.arrayContaining([
        ["127.0.0.1", "/denied"],
        ["localhost", "/api/account"],
      ]),
    );
    expect(origins).toEqual([site.origin, site.origin]);
  });

  it("reports no 401 for a basic auth challenge the HTTP credentials answer", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    const browser = await session.browserFor("customer");
    await browser.setHttpCredentials(BASIC);
    const origins: string[] = [];
    browser.onUnauthorized?.((origin) => origins.push(origin));

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/account` },
      { tap: { id: "gated" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 1: 200" } } },
      { wait: { ms: 300 } },
    ]);

    expect(checks().map((check) => [check.observed, check.ok])).toEqual([["call 1: 200", true]]);
    expect(origins).toEqual([]);
  });

  it("reports a 401 when the server rejects the basic credentials", async () => {
    const { session, evidence } = await open();
    const checks = recorded(evidence);
    const browser = await session.browserFor("customer");
    await browser.setHttpCredentials({ username: "ops", password: "fake-wrong-password" });
    const origins: string[] = [];
    browser.onUnauthorized?.((origin) => origins.push(origin));

    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/account` },
      { tap: { id: "gated" } },
      { expect: { text: { field: { id: "calls" }, equals: "call 1: 401" } } },
      { wait: { ms: 300 } },
    ]);

    expect(checks().map((check) => [check.observed, check.ok])).toEqual([["call 1: 401", true]]);
    expect(origins).toEqual([site.origin]);
  });

  it("blocks the next step in another identity's context when a navigation was refused after its step", async () => {
    const { session, evidence } = await open();
    await runSteps(stepContext(session, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/` },
    ]);
    const customer = await session.contextFor("customer");
    // clicked outside a step, so no step of the customer can throw the refusal first
    await (await customer.page()).getByRole("button", { name: "Pay" }).click();

    const refused = runUntilThrown(
      stepContext(session, { env, evidence, root, identity: "agent" }),
      [{ wait: { ms: 500 } }],
    );

    await expect(refused).rejects.toThrow(new HostNotAllowed("localhost", env.name));
  });

  it("throws from close a navigation refused after the last step, and keeps the trace of a passing case", async () => {
    const { session: opened, evidence } = await open();
    await runSteps(stepContext(opened, { env, evidence, root }), [{ open: `${site.origin}/` }]);
    const guarded = await opened.contextFor(undefined);
    // the route that refuses the navigation runs after this event, so close starts before the refusal lands
    const navigation = guarded.context.waitForEvent("request", (request) =>
      request.url().endsWith("/away"),
    );
    // clicked outside a step, so no step can throw the refusal first
    await (await guarded.page()).getByRole("button", { name: "Pay" }).click();
    await navigation;
    session = undefined;

    await expect(opened.close({ status: "pass", evidence })).rejects.toThrow(
      new HostNotAllowed("localhost", env.name),
    );

    expect(await readdir(join(root, "runs", CASE_ID))).toEqual(["01-trace.zip"]);
    expect(site.requests.map((request) => request.path)).not.toContain("/away");
  });

  it("attaches one scrubbed trace per context when the case does not pass", async () => {
    const { session: opened, evidence } = await open();
    await (await opened.browserFor("customer")).setExtraHeaders({ Authorization: BEARER });
    await runSteps(stepContext(opened, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/` },
    ]);
    await runSteps(stepContext(opened, { env, evidence, root }), [{ open: `${site.origin}/next` }]);

    session = undefined;
    await opened.close({ status: "fail", evidence });

    const caseDir = join(root, "runs", CASE_ID);
    expect(await readdir(caseDir)).toEqual(["01-trace-customer.zip", "02-trace-anonymous.zip"]);
    const entries = unzipSync(await readFile(join(caseDir, "01-trace-customer.zip")));
    expect(Object.keys(entries)).toContain("trace.network");
    const text = Object.values(entries)
      .map((bytes) => new TextDecoder().decode(bytes))
      .join("\n");
    expect(text).toContain("/pixel.png");
    expect(text).not.toContain("fake-bearer-7f3a9c");
  });

  it("keeps HTTP credentials out of the trace even when the redactor does not know them", async () => {
    const { session: opened, evidence } = await open();
    await (await opened.browserFor("customer")).setHttpCredentials(BASIC);
    await runSteps(stepContext(opened, { env, evidence, root, identity: "customer" }), [
      { open: `${site.origin}/gated/start` },
      { expect: { text: { field: { css: "h1" }, equals: "Landing" } } },
    ]);

    session = undefined;
    await opened.close({ status: "fail", evidence });

    const entries = unzipSync(await readFile(join(root, "runs", CASE_ID, "01-trace.zip")));
    const text = Object.values(entries)
      .map((bytes) => new TextDecoder().decode(bytes))
      .join("\n");
    expect(text).toContain("/gated/landing");
    expect(text).not.toContain(BASIC.password);
    expect(text).not.toContain(BASIC_AUTHORIZATION.slice("Basic ".length));
    expect(text).not.toContain("setHTTPCredentials");
  });

  it("names the trace trace.zip when the case used one context, and keeps none when it passes", async () => {
    const failed = await open();
    await runSteps(stepContext(failed.session, { env, evidence: failed.evidence, root }), [
      { open: `${site.origin}/` },
    ]);
    session = undefined;
    await failed.session.close({ status: "blocked", evidence: failed.evidence });
    expect(await readdir(join(root, "runs", CASE_ID))).toEqual(["01-trace.zip"]);

    const passed = await open();
    const passing = newEvidence(join(root, "runs"), "WEB-ORDER-002");
    await runSteps(stepContext(passed.session, { env, evidence: passing, root }), [
      { open: `${site.origin}/` },
    ]);
    session = undefined;
    await passed.session.close({ status: "pass", evidence: passing });
    await expect(readdir(join(root, "runs", "WEB-ORDER-002"))).rejects.toThrow(/ENOENT/);
  });
});

describe.each(ENGINES)("browser settings on %s", (engine) => {
  let site: Site;
  const sessions: WebSession[] = [];
  const roots: string[] = [];

  beforeAll(async () => {
    site = await startSite({ "/": html("<h1>Home</h1>") });
  });

  afterAll(() => site.close());

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      const root = roots.pop()!;
      await session.close({ status: "pass", evidence: newEvidence(root, CASE_ID) });
      await rm(root, { recursive: true, force: true });
    }
  });

  async function pageWith(settings: Record<string, unknown>) {
    const root = await tempDir();
    roots.push(root);
    const session = await launch(engine, { env: demoEnv(), runDir: root, settings });
    sessions.push(session);
    const page = await session.pageFor(undefined);
    await page.goto(`${site.origin}/`);
    return page;
  }

  it("opens a case context at the viewport, and at 1280x720 without one", async () => {
    const sized = await pageWith({ viewport: { width: 640, height: 480 } });
    const plain = await pageWith({});

    expect(sized.viewportSize()).toEqual({ width: 640, height: 480 });
    expect(plain.viewportSize()).toEqual({ width: 1280, height: 720 });
  });

  it("opens a case context with no fixed viewport for viewport: window", async () => {
    const page = await pageWith({ viewport: "window" });

    expect(page.viewportSize()).toBeNull();
  });

  // WebKit's Linux launcher refuses an option it does not know and has none that is harmless; the pool key does not
  // depend on the engine
  it.skipIf(engine === "webkit" && process.platform === "linux")(
    "leases two browsers for targets that differ in args and one for targets that match",
    async () => {
      // an argument Chromium and Firefox, and WebKit on macOS, accept without effect
      const one = await pageWith({ args: ["--bazam-test-one"] });
      const same = await pageWith({ args: ["--bazam-test-one"] });
      const other = await pageWith({ args: ["--bazam-test-two"] });

      expect(same.context().browser()).toBe(one.context().browser());
      expect(other.context().browser()).not.toBe(one.context().browser());
    },
  );

  it.runIf(engine === "chromium")("passes args to the browser launch", async () => {
    const page = await pageWith({ args: ["--user-agent=example-agent/1.0"] });

    expect(await page.evaluate(() => navigator.userAgent)).toBe("example-agent/1.0");
  });

  // geolocation is the one permission name all three Playwright builds accept
  it("grants only the listed permissions", async () => {
    const query = (page: Awaited<ReturnType<typeof pageWith>>) =>
      page.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state);

    const granted = await pageWith({ permissions: ["geolocation"] });
    const plain = await pageWith({});

    expect(await query(granted)).toBe("granted");
    expect(await query(plain)).not.toBe("granted");
  });
});

describe("playwrightDriver", () => {
  it("records a failed ui check when the page never meets the expectation", async () => {
    const site = await startSite({ "/": html('<p data-testid="out">Draft</p>') });
    const root = await tempDir();
    const env = demoEnv();
    const session = await launch("chromium", { env, runDir: root });
    const evidence = newEvidence(root, CASE_ID);
    const record = vi.spyOn(evidence, "record");
    try {
      await runSteps(stepContext(session, { env, evidence, root }), [
        { open: `${site.origin}/` },
        { expect: { text: { field: { id: "out" }, contains: "Paid" } } },
      ]);
    } finally {
      await session.close({ status: "fail", evidence });
      await site.close();
      await rm(root, { recursive: true, force: true });
    }

    expect(record.mock.calls.map(([check]) => check)).toEqual([
      {
        name: 'text of id=out contains "Paid"',
        kind: "ui",
        expected: { contains: "Paid" },
        observed: "Draft",
        ok: false,
      },
    ]);
  });

  it("refuses to launch when a configured screenshot selector does not parse", async () => {
    const root = await tempDir();
    const redactor = new Redactor(defaultRedactionRules());
    redactor.configure({ patterns: [], screenshotSelectors: ["#account", "#account["] });
    try {
      await expect(launch("chromium", { env: demoEnv(), runDir: root, redactor })).rejects.toThrow(
        /^redaction\.screenshotSelectors has "#account\[", which Playwright cannot parse: .*while parsing css selector/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("probe reports browser.login and webauthn.virtual and refuses a channel on another engine", async () => {
    const options = {
      env: demoEnv(),
      target: "web",
      runDir: "runs",
      redactor: new Redactor(defaultRedactionRules()),
    };

    await expect(playwrightDriver.probe({ ...options, settings: {} })).resolves.toEqual(
      new Set(["browser.login", "webauthn.virtual"]),
    );
    await expect(
      playwrightDriver.probe({ ...options, settings: { browser: "firefox", channel: "chrome" } }),
    ).rejects.toThrow(/target web: .*a channel needs browser: chromium/s);
  });

  it.each([
    ["a viewport of width 0", { viewport: { width: 0, height: 10 } }, /at viewport\.width/],
    [
      "a viewport word other than window",
      { viewport: "screen" },
      /a viewport is window or \{ width, height \} in CSS pixels/,
    ],
    ["a non-string args entry", { args: ["--lang=en", 3] }, /at args\[1\]/],
  ])("refuses %s when the settings parse", async (_name, settings, field) => {
    const options = {
      env: demoEnv(),
      target: "web",
      runDir: "runs",
      redactor: new Redactor(defaultRedactionRules()),
    };

    await expect(playwrightDriver.probe({ ...options, settings })).rejects.toThrow(
      new RegExp(`^target web: [\\s\\S]*${field.source}`),
    );
  });

  it.each(["data.qa", "data:qa", "1qa"])(
    "refuses the testIdAttribute %s when the settings parse",
    async (attribute) => {
      const options = {
        env: demoEnv(),
        target: "web",
        runDir: "runs",
        redactor: new Redactor(defaultRedactionRules()),
      };

      await expect(
        playwrightDriver.probe({ ...options, settings: { testIdAttribute: attribute } }),
      ).rejects.toThrow(/target web: .*testIdAttribute takes a letter or "_"/s);
    },
  );
});
