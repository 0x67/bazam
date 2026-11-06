import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { AuthContext, AuthStrategy, HttpRequestDraft, JsonValue } from "../../src/auth/index.ts";
import { guardedHttp, type HttpResponse } from "../../src/driver/http.ts";
import type { Environment } from "../../src/env/index.ts";
import { defaultRedactionRules, Redactor } from "../../src/redact/index.ts";

export interface ReceivedRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface LocalServer {
  origin: string;
  received: ReceivedRequest[];
  close(): Promise<void>;
}

/** Serves `route` on 127.0.0.1 and keeps every request it received. */
export async function serve(route: (request: ReceivedRequest, response: ServerResponse) => void): Promise<LocalServer> {
  const received: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const request = { method: req.method ?? "", url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(request);
      route(request, res);
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

const env: Environment = { name: "local", production: false, vars: {}, hosts: new Set(["127.0.0.1"]), challenges: {}, locale: "en" };

/** A context for the identity customer whose HTTP client reaches 127.0.0.1 only. */
export function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    identity: "customer",
    fields: {},
    env,
    http: guardedHttp({ env, redactor: new Redactor(defaultRedactionRules()), log: () => {} }),
    projectRoot: fileURLToPath(new URL(".", import.meta.url)),
    person: { ask: async () => ({ kind: "timeout" }) },
    now: () => new Date(),
    ...overrides,
  };
}

export function draft(method: string, url: string, body?: string): HttpRequestDraft {
  const request: HttpRequestDraft = { method, url: new URL(url), headers: new Headers() };
  if (body !== undefined) request.body = new TextEncoder().encode(body);
  return request;
}

/** Parses the settings, acquires a credential, applies it to the request and sends it. */
export async function sendWith<Config, Credential extends JsonValue>(
  strategy: AuthStrategy<Config, Credential>,
  settings: unknown,
  request: HttpRequestDraft,
  ctx: AuthContext,
): Promise<{ credential: Credential; response: HttpResponse }> {
  const config = strategy.config.parse(settings);
  const credential = await strategy.acquire(config, ctx);
  await strategy.apply(credential, { kind: "http", request }, config);
  return { credential, response: await ctx.http.send(request) };
}

/** `text` as the redactor writes it once it holds the strategy's secrets, which Identities registers. */
export function redacted(secrets: readonly string[], text: string): string {
  const redactor = new Redactor(defaultRedactionRules());
  for (const secret of secrets) redactor.register(secret);
  return redactor.text(text);
}
