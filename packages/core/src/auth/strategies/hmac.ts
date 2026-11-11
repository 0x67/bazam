import { createHash, createHmac, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { HttpResponse } from "../../driver/http.ts";
import { loadAuthHook } from "../hooks.ts";
import { defineAuthStrategy, type HttpRequestDraft } from "../strategy.ts";
import { checkProbe, RequestCheck, requestDraft } from "./session-cookie.ts";

const SIGNED_PARTS = ["method", "path", "query", "timestamp", "nonce", "bodySha256", "keyId"];
const HEADER_PARTS = [...SIGNED_PARTS, "signature"];
const PLACEHOLDER = /\{([A-Za-z0-9]+)\}/g;

function template(parts: readonly string[]) {
  return z
    .string()
    .refine(
      (text) => [...text.matchAll(PLACEHOLDER)].every((match) => parts.includes(match[1] ?? "")),
      {
        error: `a template takes only ${parts.map((part) => `{${part}}`).join(", ")}`,
      },
    );
}

const HmacConfig = z
  .strictObject({
    keyId: z.string().min(1),
    secret: z.string().min(1),
    algorithm: z.enum(["sha1", "sha256", "sha512"]).default("sha256"),
    encoding: z.enum(["hex", "base64"]).default("hex"),
    stringToSign: template(SIGNED_PARTS).default(
      "{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{bodySha256}",
    ),
    headers: z.record(z.string().min(1), template(HEADER_PARTS)).default({
      "X-Key-Id": "{keyId}",
      "X-Timestamp": "{timestamp}",
      "X-Nonce": "{nonce}",
      "X-Signature": "{signature}",
    }),
    timestamp: z.enum(["unix-seconds", "unix-millis", "iso-8601"]).default("unix-seconds"),
    maxSkewSeconds: z.number().positive().optional(),
    /**
     * A request that checks the credential, signed like any other. With maxSkewSeconds, the Date header of its
     * answer is also compared with the local clock.
     */
    probe: RequestCheck.optional(),
    /** A project module whose default export returns the headers; replaces stringToSign and headers. */
    sign: z.string().min(1).optional(),
  })
  .refine((config) => config.maxSkewSeconds === undefined || config.probe !== undefined, {
    path: ["probe"],
    error:
      "maxSkewSeconds needs a probe request, since the local clock is compared with the Date header of its answer",
  });
type HmacConfig = z.infer<typeof HmacConfig>;

type HmacCredential = {
  keyId: string;
  secret: string;
  /** The absolute path of the sign hook, so apply, which gets no project root, can import it again. */
  signHook?: string;
};

export const hmacStrategy = defineAuthStrategy<HmacConfig, HmacCredential>({
  name: "hmac",
  config: HmacConfig,
  cacheable: false,
  acquire: async (config, ctx) => {
    const credential: HmacCredential = { keyId: config.keyId, secret: config.secret };
    if (config.sign === undefined) return credential;
    // refuses a hook outside the project root before any request is signed
    await loadAuthHook(ctx.projectRoot, config.sign);
    credential.signHook = await realpath(resolve(ctx.projectRoot, config.sign));
    return credential;
  },
  apply: async (credential, target, config) => {
    if (target.kind === "browser")
      throw new Error("hmac signs each HTTP request, so it cannot apply to a browser");
    await sign(credential, target.request, config, new Date());
  },
  probe: async (credential, config, ctx) => {
    if (config.probe === undefined) return true;
    const draft = requestDraft(config.probe);
    await sign(credential, draft, config, ctx.now());
    const response = await ctx.http.send(draft);
    // before the status, since a server whose clock is far off refuses the signature too
    if (config.maxSkewSeconds !== undefined)
      assertClockSkew(response, config.maxSkewSeconds, ctx.now(), draft.url);
    return checkProbe(config.probe, response);
  },
  secrets: (credential) => [credential.secret],
});

async function sign(
  credential: HmacCredential,
  request: HttpRequestDraft,
  config: HmacConfig,
  now: Date,
): Promise<void> {
  const headers =
    credential.signHook === undefined
      ? templateHeaders(credential, request, config, now)
      : await hookHeaders(credential.signHook, credential, request);
  for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
}

async function hookHeaders(
  path: string,
  credential: HmacCredential,
  request: HttpRequestDraft,
): Promise<Record<string, string>> {
  // acquire already checked that the hook is inside the project root
  const hook = await loadAuthHook(dirname(path), path);
  return hook(request, { keyId: credential.keyId, secret: credential.secret });
}

function templateHeaders(
  credential: HmacCredential,
  request: HttpRequestDraft,
  config: HmacConfig,
  now: Date,
): Record<string, string> {
  const parts: Record<string, string> = {
    method: request.method.toUpperCase(),
    path: request.url.pathname,
    query: request.url.search.slice(1),
    timestamp: formatTimestamp(now, config.timestamp),
    nonce: randomUUID(),
    bodySha256: createHash("sha256")
      .update(request.body ?? new Uint8Array())
      .digest("hex"),
    keyId: credential.keyId,
  };
  const signature = createHmac(config.algorithm, credential.secret)
    .update(fill(config.stringToSign, parts))
    .digest(config.encoding);
  return Object.fromEntries(
    Object.entries(config.headers).map(([name, value]) => [
      name,
      fill(value, { ...parts, signature }),
    ]),
  );
}

function fill(text: string, parts: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (written, part: string) => parts[part] ?? written);
}

function formatTimestamp(now: Date, mode: HmacConfig["timestamp"]): string {
  switch (mode) {
    case "unix-seconds":
      return String(Math.floor(now.getTime() / 1000));
    case "unix-millis":
      return String(now.getTime());
    case "iso-8601":
      return now.toISOString();
  }
}

function assertClockSkew(
  response: HttpResponse,
  maxSkewSeconds: number,
  now: Date,
  url: URL,
): void {
  const date = Date.parse(response.headers.get("date") ?? "");
  if (Number.isNaN(date))
    throw new Error(
      `${url.origin} sent no readable Date header, so the clock skew cannot be checked; point probe at a request whose answer has one, or remove maxSkewSeconds`,
    );
  const skewSeconds = Math.abs(date - now.getTime()) / 1000;
  if (skewSeconds > maxSkewSeconds) {
    throw new Error(
      `the local clock is ${Math.round(skewSeconds)} s away from the Date of ${url.origin}, more than maxSkewSeconds ${maxSkewSeconds}`,
    );
  }
}
