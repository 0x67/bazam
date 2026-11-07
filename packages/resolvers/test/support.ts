import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { builtinKinds, type ChallengeKindSpec, type ChallengeRequest, type ResolverContext } from "@bazam/core/challenge";
import { guardedHttp } from "@bazam/core/driver";
import { EnvsConfig } from "@bazam/core/env";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";

export const NOW = new Date("2026-11-06T09:30:00.000Z");

const demo = EnvsConfig.parse({ demo: { production: false, hosts: ["127.0.0.1"] } })["demo"]!;

/** A context on an env that allows only 127.0.0.1, with no person and no secrets unless `overrides` adds them. */
export function context(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    env: demo,
    http: guardedHttp({ env: demo, redactor: new Redactor(defaultRedactionRules()), log: () => {} }),
    channel: {
      ask: async () => {
        throw new Error("no person in this test");
      },
    },
    prompt: { runId: "20261106-093000-a1b2", timeoutMs: 60_000 },
    stateDir: "/no/state/in/this/test",
    secrets: async (key) => {
      throw new Error(`no secret ${key} in this test`);
    },
    now: () => NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function challenge(kind: string, params: Record<string, string>): ChallengeRequest {
  return { kind, caseId: "AUTH-EMAIL-001", identity: "customer", step: 2, params };
}

export function builtinKind(name: string): ChallengeKindSpec {
  const kind = builtinKinds.find((spec) => spec.name === name);
  if (kind === undefined) throw new Error(`no built-in kind ${name}`);
  return kind;
}

export interface Reply {
  status: number;
  body?: unknown;
}

const servers: Server[] = [];

/** Serves JSON replies from `route` on 127.0.0.1 and returns the origin. A request `route` gives no reply hangs. */
export async function serveJson(route: (url: URL) => Reply | undefined): Promise<string> {
  const server = createServer((req, res) => {
    const reply = route(new URL(req.url ?? "/", "http://127.0.0.1"));
    if (reply === undefined) return;
    res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function closeServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
