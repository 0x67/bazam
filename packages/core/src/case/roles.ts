import { z } from "zod";

const RoleName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, { error: 'a role name looks like "tester" or "shop-admin"' });

/** Each role, the identities that may play it and the one that plays it when a run names none. */
export const RolesConfig = z.record(
  RoleName,
  z.strictObject({
    identities: z.array(z.string().min(1)).min(1),
    default: z.string().min(1).optional(),
  }),
);
export type RolesConfig = z.infer<typeof RolesConfig>;

/** A `--as` that names an unknown role or an identity the role does not list. */
export class RoleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleRefused";
  }
}

/** The identity each role plays: the one requested, else the role's default. A role with neither is left out. */
export function roleBindings(
  roles: RolesConfig,
  requested: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const [role, identity] of Object.entries(requested)) {
    const entry = Object.hasOwn(roles, role) ? roles[role] : undefined;
    if (entry === undefined) {
      const known = Object.keys(roles);
      throw new RoleRefused(
        `unknown role "${role}"; roles: ${known.length === 0 ? "none" : known.join(", ")}`,
      );
    }
    if (!entry.identities.includes(identity)) {
      throw new RoleRefused(`role ${role} lists ${entry.identities.join(", ")}, not ${identity}`);
    }
    bindings.set(role, identity);
  }
  for (const [role, { default: fallback }] of Object.entries(roles)) {
    if (!bindings.has(role) && fallback !== undefined) bindings.set(role, fallback);
  }
  return bindings;
}

// `$${` matches first, so an escaped brace never opens a placeholder; see env/placeholders.ts
const IDENTITY_TOKEN = /\$\$\{|\$\{identity\.([^.}]*)\.([^}]*)\}/g;

/** A copy of `value` with each bound role replaced in `as` keys and in `${identity.<role>.` placeholders. */
export function bindRoles<T>(value: T, bindings: ReadonlyMap<string, string>): T {
  if (bindings.size === 0) return value;
  return bind(value, bindings) as T;
}

function bind(value: unknown, bindings: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return bindText(value, bindings);
  if (Array.isArray(value)) return value.map((item) => bind(item, bindings));
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const identity = key === "as" && typeof item === "string" ? bindings.get(item) : undefined;
    copy[key] = identity ?? bind(item, bindings);
  }
  return copy;
}

function bindText(text: string, bindings: ReadonlyMap<string, string>): string {
  return text.replace(
    IDENTITY_TOKEN,
    (token, role: string | undefined, rest: string | undefined) => {
      const identity = role === undefined ? undefined : bindings.get(role);
      return identity === undefined ? token : `\${identity.${identity}.${rest}}`;
    },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
