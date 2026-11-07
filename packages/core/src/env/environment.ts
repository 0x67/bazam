import { z } from "zod";
import type { CaseSpec } from "../case/index.ts";

export interface Environment {
  name: string;
  production: boolean;
  vars: Readonly<Record<string, string>>;
  /** Lower case host names, without scheme or port. */
  hosts: ReadonlySet<string>;
  /** Resolver chain per challenge kind, in the order they are tried. */
  challenges: Readonly<Record<string, readonly string[]>>;
  /** BCP 47 tag for display text such as country names. */
  locale: string;
}

const EnvironmentConfig = z.strictObject({
  // required, so a production env is never one by omission
  production: z.boolean(),
  vars: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { error: "a var name is letters, digits and underscores" }),
      z.string(),
    )
    .default({}),
  hosts: z
    .array(
      z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i, {
        error: 'a host is a bare name such as "uat.app.example.test", without scheme, port or path',
      }),
    )
    .min(1),
  challenges: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
  locale: z.string().refine(isLocale, { error: 'a locale is a BCP 47 tag such as "en" or "id-ID"' }).default("en"),
});

function isLocale(tag: string): boolean {
  try {
    Intl.getCanonicalLocales(tag);
    return true;
  } catch {
    return false;
  }
}

/** The `envs` mapping of the project config, parsed into one `Environment` per name. */
export const EnvsConfig = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]*$/, { error: 'an env name looks like "uat" or "demo-prod"' }),
    EnvironmentConfig,
  )
  .transform((envs): Record<string, Environment> =>
    Object.fromEntries(
      Object.entries(envs).map(([name, env]) => [
        name,
        { name, ...env, hosts: new Set(env.hosts.map((host) => host.toLowerCase())) },
      ]),
    ),
  );

export class HostNotAllowed extends Error {
  readonly host: string;

  constructor(host: string, env: string) {
    super(`host ${host === "" ? "(none)" : host} is not in the hosts of env ${env}`);
    this.name = "HostNotAllowed";
    this.host = host;
  }
}

export class ProdCaseRefused extends Error {
  constructor(caseId: string, env: string) {
    super(`case ${caseId} is not prod_safe and env ${env} is production`);
    this.name = "ProdCaseRefused";
  }
}

export class ProdWriteRefused extends Error {
  constructor(method: string, env: string) {
    super(`${method} needs write: true in production env ${env}`);
    this.name = "ProdWriteRefused";
  }
}

/** Ports and schemes are not checked; a URL without a host, such as `file:` or `about:blank`, is refused. */
export function assertHostAllowed(env: Environment, url: URL): void {
  if (!env.hosts.has(url.hostname)) throw new HostNotAllowed(url.hostname, env.name);
}

export function assertProdSafe(env: Environment, spec: CaseSpec): void {
  if (env.production && !spec.prod_safe) throw new ProdCaseRefused(spec.id, env.name);
}

export function assertProdWrite(env: Environment, method: string, step: { write?: boolean | undefined }): void {
  const upper = method.toUpperCase();
  if (env.production && upper !== "GET" && step.write !== true) throw new ProdWriteRefused(upper, env.name);
}
