export interface PlaceholderSources {
  env(key: string): string | undefined;
  secret(key: string): Promise<string | undefined>;
  identity(name: string, field: string): string | undefined;
  /** `expression` is `id`, `time` or `random(min, max, decimals)`; see run-values.ts::RunValues. */
  run(expression: string): string | undefined;
  case(key: string): string | undefined;
}

export class UnresolvedPlaceholder extends Error {
  /** As written, such as `${env.APP_URL}`. */
  readonly placeholder: string;

  constructor(placeholder: string) {
    super(`unresolved placeholder ${placeholder}`);
    this.name = "UnresolvedPlaceholder";
    this.placeholder = placeholder;
  }
}

// `$${` matches first, so an escaped brace never opens a placeholder
const TOKEN = /\$\$\{|\$\{([^}]*)\}/g;

/** Each unescaped placeholder in the strings of `value`, as written, once, in order of appearance. */
export function findPlaceholders(value: unknown): string[] {
  const found = new Set<string>();
  visitStrings(value, (text) => {
    for (const match of text.matchAll(TOKEN)) if (match[1] !== undefined) found.add(match[0]);
  });
  return [...found];
}

/**
 * Returns a copy of `value` with every placeholder in its strings replaced and every `$${` written as `${`.
 * Placeholders resolve one at a time in document order, so seeded run values come out the same on replay.
 * Resolved text is not scanned again.
 */
export async function resolvePlaceholders<T>(value: T, sources: PlaceholderSources): Promise<T> {
  return (await resolveValue(value, sources)) as T;
}

async function resolveValue(value: unknown, sources: PlaceholderSources): Promise<unknown> {
  if (typeof value === "string") return resolveString(value, sources);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) items.push(await resolveValue(item, sources));
    return items;
  }
  if (!isPlainObject(value)) return value;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) entries.push([key, await resolveValue(item, sources)]);
  return Object.fromEntries(entries);
}

async function resolveString(text: string, sources: PlaceholderSources): Promise<string> {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    out += text.slice(last, match.index);
    out += match[1] === undefined ? "${" : await resolveOne(match[0], match[1], sources);
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

async function resolveOne(placeholder: string, expression: string, sources: PlaceholderSources): Promise<string> {
  const [namespace, path] = splitFirst(expression);
  let value: unknown;
  if (path !== "") {
    switch (namespace) {
      case "env":
        value = sources.env(path);
        break;
      case "secret":
        value = await sources.secret(path);
        break;
      case "identity": {
        const [name, field] = splitFirst(path);
        if (field !== "") value = sources.identity(name, field);
        break;
      }
      case "run":
        value = sources.run(path);
        break;
      case "case":
        value = sources.case(path);
        break;
    }
  }
  // a string check, so a source that indexes a plain object cannot hand back an inherited member
  if (typeof value !== "string") throw new UnresolvedPlaceholder(placeholder);
  return value;
}

function splitFirst(text: string): [string, string] {
  const dot = text.indexOf(".");
  return dot === -1 ? [text, ""] : [text.slice(0, dot), text.slice(dot + 1)];
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) visitStrings(item, visit);
  else if (isPlainObject(value)) for (const item of Object.values(value)) visitStrings(item, visit);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
