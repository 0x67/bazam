import type { z } from "zod";
import type { HumanChannel } from "../challenge/index.ts";
import type { GuardedHttp } from "../driver/http.ts";
import type { Environment } from "../env/index.ts";
import type { BrowserLogin, BrowserSession } from "./browser.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface HttpRequestDraft {
  method: string;
  url: URL;
  headers: Headers;
  body?: Uint8Array;
  /** "manual" returns a 3xx response as it came instead of following its Location. */
  redirect?: "follow" | "manual";
  /** Aborts the request on every hop; the send then rejects with the signal's reason. */
  signal?: AbortSignal;
}

export type ApplyTarget = { kind: "http"; request: HttpRequestDraft } | { kind: "browser"; session: BrowserSession };

export interface AuthContext {
  identity: string;
  /** The identity's fixture fields. */
  fields: Readonly<Record<string, string>>;
  env: Environment;
  /** For the strategy's own requests, such as token calls; sends no identity's credential. */
  http: GuardedHttp;
  /** Where hook paths such as hmac's `sign:` resolve, through loadAuthHook. */
  projectRoot: string;
  /** Present when the surface's driver offers browser.login. */
  browser?: BrowserLogin;
  /** Reaches the person a login waits for. */
  person: HumanChannel;
  now(): Date;
}

export interface AuthStrategy<Config, Credential extends JsonValue> {
  name: string;
  config: z.ZodType<Config>;
  /** False for static secrets such as api-key, basic and hmac, which never touch disk. */
  cacheable: boolean;
  keepaliveMs?: number;
  /**
   * True when acquire waits for a person, so preflight runs that login after the scripted ones. Gets the
   * surface's `with:` settings as written, placeholders unresolved, so planning fetches no secret.
   */
  needsPerson?(settings: Readonly<Record<string, unknown>>): boolean;
  acquire(config: Config, ctx: AuthContext): Promise<Credential>;
  apply(credential: Credential, target: ApplyTarget, config: Config): Promise<void>;
  refresh?(credential: Credential, config: Config, ctx: AuthContext): Promise<Credential>;
  /**
   * False when refresh cannot renew this credential, such as a token without a refresh token, so the engine
   * logs in again instead. Gets the raw settings, as needsPerson does.
   */
  canRefresh?(credential: Credential, settings: Readonly<Record<string, unknown>>): boolean;
  expiresAt?(credential: Credential): Date | undefined;
  probe?(credential: Credential, config: Config, ctx: AuthContext): Promise<boolean>;
  revoke?(credential: Credential, config: Config, ctx: AuthContext): Promise<void>;
  /** The values in the credential that the redactor must mask. */
  secrets(credential: Credential): string[];
}

/** The credential works but belongs to someone else: these body paths of the probe answer did not match. */
export class IdentityMismatch extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(`the probe answer does not match at ${paths.join(", ")}`);
    this.name = "IdentityMismatch";
    this.paths = paths;
  }
}

/** A probe or refresh header takes its value from a cookie the cached state does not send. */
export class MissingHeaderCookie extends Error {
  constructor(purpose: string, identity: string, cookie: string, header: string, origin: string) {
    super(
      `the session-cookie ${purpose} of ${identity} needs cookie ${cookie} for header ${header}, which the cached state does not send to ${origin}`,
    );
    this.name = "MissingHeaderCookie";
  }
}

export function defineAuthStrategy<Config, Credential extends JsonValue>(
  strategy: AuthStrategy<Config, Credential>,
): AuthStrategy<Config, Credential> {
  return strategy;
}
