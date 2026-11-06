import type { z } from "zod";
import type { HumanChannel } from "../challenge/index.ts";
import type { Environment } from "../env/index.ts";
import type { BrowserLogin, BrowserSession } from "./browser.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface HttpRequestDraft {
  method: string;
  url: URL;
  headers: Headers;
  body?: Uint8Array;
}

export type ApplyTarget = { kind: "http"; request: HttpRequestDraft } | { kind: "browser"; session: BrowserSession };

export interface AuthContext {
  identity: string;
  /** The identity's fixture fields. */
  fields: Readonly<Record<string, string>>;
  env: Environment;
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
   * True when acquire waits for a person, so preflight asks for it after the scripted logins. Gets the
   * surface's `with:` settings as written, placeholders unresolved, so planning fetches no secret.
   */
  needsPerson?(settings: Readonly<Record<string, unknown>>): boolean;
  acquire(config: Config, ctx: AuthContext): Promise<Credential>;
  apply(credential: Credential, target: ApplyTarget, config: Config): Promise<void>;
  refresh?(credential: Credential, config: Config, ctx: AuthContext): Promise<Credential>;
  expiresAt?(credential: Credential): Date | undefined;
  probe?(credential: Credential, config: Config, ctx: AuthContext): Promise<boolean>;
  revoke?(credential: Credential, config: Config, ctx: AuthContext): Promise<void>;
  /** The values in the credential that the redactor must mask. */
  secrets(credential: Credential): string[];
}

export function defineAuthStrategy<Config, Credential extends JsonValue>(
  strategy: AuthStrategy<Config, Credential>,
): AuthStrategy<Config, Credential> {
  return strategy;
}
