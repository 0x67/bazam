import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { hmacStrategy } from "../../src/auth/strategies/index.ts";
import { authContext, draft, redacted, sendWith, serve, type LocalServer, type ReceivedRequest } from "./support.ts";

const SECRET = "fake-hmac-secret";
const SETTINGS = { keyId: "fake-key-id", secret: SECRET };

const SIGN_HOOK = `
import { createHmac } from "node:crypto";
interface Draft { method: string; url: URL }
export default (request: Draft, credential: { keyId: string; secret: string }): Record<string, string> => ({
  "X-Key-Id": credential.keyId,
  "X-Hook-Signature": createHmac("sha256", credential.secret).update(\`\${request.method} \${request.url.pathname}\`).digest("hex"),
});
`;

function hmacHex(text: string): string {
  return createHmac("sha256", SECRET).update(text).digest("hex");
}

/** Checks the signature the way the demo's HMAC endpoint does, from the default templates. */
function templateSignatureIsValid(request: ReceivedRequest): boolean {
  const { headers } = request;
  const bodySha256 = createHash("sha256").update(request.body).digest("hex");
  const signed = [request.method, request.url.pathname, request.url.search.slice(1), headers["x-timestamp"], headers["x-nonce"], bodySha256].join("\n");
  return headers["x-key-id"] === "fake-key-id" && headers["x-signature"] === hmacHex(signed);
}

describe("hmacStrategy", () => {
  let server: LocalServer;
  let dir: string;
  let project: string;

  beforeAll(async () => {
    server = await serve((request, response) => {
      switch (request.url.pathname) {
        case "/api/hmac/echo":
          return response.writeHead(templateSignatureIsValid(request) ? 200 : 401).end();
        case "/api/hmac/hook": {
          const valid = request.headers["x-hook-signature"] === hmacHex(`${request.method} ${request.url.pathname}`);
          return response.writeHead(valid ? 200 : 401).end();
        }
        default:
          return response.writeHead(404).end();
      }
    });
    dir = await mkdtemp(join(tmpdir(), "hmac-test-"));
    project = join(dir, "project");
    await mkdir(join(project, "hooks"), { recursive: true });
    await writeFile(join(project, "hooks", "sign.ts"), SIGN_HOOK);
    await writeFile(join(dir, "outside.ts"), SIGN_HOOK);
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs method, path, query, timestamp, nonce and body hash so the server verifies each request", async () => {
    const ctx = authContext();
    const url = `${server.origin}/api/hmac/echo?order=42`;

    const first = await sendWith(hmacStrategy, SETTINGS, draft("POST", url, '{"amount":"1.50"}'), ctx);
    const second = await sendWith(hmacStrategy, SETTINGS, draft("POST", url, '{"amount":"2.50"}'), ctx);

    expect([first.response.status, second.response.status]).toEqual([200, 200]);
    const nonces = server.received.slice(-2).map((request) => request.headers["x-nonce"]);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it.each([
    ["unix-seconds", "1794042000"],
    ["unix-millis", "1794042000000"],
    ["iso-8601", "2026-11-07T09:00:00.000Z"],
  ])("formats the timestamp as %s", async (timestamp, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T09:00:00.000Z"));
    const config = hmacStrategy.config.parse({ ...SETTINGS, timestamp });
    const request = draft("GET", `${server.origin}/api/hmac/echo`);

    await hmacStrategy.apply(await hmacStrategy.acquire(config, authContext()), { kind: "http", request }, config);

    expect(request.headers.get("x-timestamp")).toBe(expected);
  });

  it("a sign hook in the project replaces the templates, and apply imports it again from the credential's path", async () => {
    const { credential, response } = await sendWith(
      hmacStrategy,
      { ...SETTINGS, sign: "./hooks/sign.ts" },
      draft("GET", `${server.origin}/api/hmac/hook`),
      authContext({ projectRoot: project }),
    );

    expect(response.status).toBe(200);
    expect(credential.signHook).toBe(await realpath(join(project, "hooks", "sign.ts")));
    expect(server.received.at(-1)?.headers["x-signature"]).toBeUndefined();
  });

  it("refuses a sign hook outside the project root", async () => {
    const config = hmacStrategy.config.parse({ ...SETTINGS, sign: "../outside.ts" });

    await expect(hmacStrategy.acquire(config, authContext({ projectRoot: project }))).rejects.toThrow("is outside the project root");
  });

  it("the probe passes within maxSkewSeconds and throws when the clock is further from the server's Date", async () => {
    const config = hmacStrategy.config.parse({ ...SETTINGS, maxSkewSeconds: 30, probe: { request: `GET ${server.origin}/api/hmac/echo` } });
    const credential = await hmacStrategy.acquire(config, authContext());
    const behind = authContext({ now: () => new Date(Date.now() - 120_000) });

    expect(await hmacStrategy.probe?.(credential, config, authContext())).toBe(true);
    await expect(hmacStrategy.probe?.(credential, config, behind)).rejects.toThrow(
      /^the local clock is 1[12]\d s away from the Date of http:\/\/127\.0\.0\.1:\d+, more than maxSkewSeconds 30$/,
    );
  });

  it("refuses maxSkewSeconds without a probe request", () => {
    expect(() => hmacStrategy.config.parse({ ...SETTINGS, maxSkewSeconds: 30 })).toThrow("maxSkewSeconds needs a probe request");
  });

  it.each([
    ["{host} in stringToSign", { stringToSign: "{method}\n{host}" }],
    ["{signature} in stringToSign", { stringToSign: "{method}\n{signature}" }],
    ["{host} in headers", { headers: { "X-Signature": "{signature}", "X-Host": "{host}" } }],
  ])("refuses %s, a placeholder it cannot fill", (_placeholder, templates) => {
    expect(() => hmacStrategy.config.parse({ ...SETTINGS, ...templates })).toThrow("a template takes only {method}");
  });

  it("the redactor masks the secret in the credential", async () => {
    const credential = await hmacStrategy.acquire(hmacStrategy.config.parse(SETTINGS), authContext());

    expect(redacted(hmacStrategy.secrets(credential), JSON.stringify(credential))).toBe('{"keyId":"fake-key-id","secret":"[redacted]"}');
  });
});
