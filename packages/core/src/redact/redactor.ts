import { z } from "zod";

export interface RedactionRules {
  /**
   * Values under a matching object key are masked whole. The key is tested in lower snake case,
   * so `accessToken` and `X-Api-Key` are seen as `access_token` and `x_api_key`.
   */
  sensitiveKeys: RegExp;
  /** Each pattern needs the g flag. */
  patterns: { pattern: RegExp; mask(match: string): string }[];
  /** Elements masked in screenshots. */
  screenshotSelectors: string[];
}

type PatternRule = RedactionRules["patterns"][number];

const MASK = "[redacted]";
const MIN_REGISTERED_LENGTH = 4;
const CONFIGURED_PATTERN_FLAGS = "gu";

/** The `redaction` entry of the project config, which adds to the default rules. */
export const RedactionConfig = z.strictObject({
  /** Regular expressions, read with the u flag; every match is masked whole. */
  patterns: z
    .array(
      z
        .string()
        .min(1)
        .superRefine((source, ctx) => {
          const error = patternError(source);
          if (error !== undefined) ctx.addIssue({ code: "custom", message: error });
        }),
    )
    .default([]),
  /**
   * Playwright selectors, such as CSS, of the page elements masked in screenshots. Also turns off DOM snapshots
   * and network entries in traces, which these selectors cannot mask.
   */
  screenshotSelectors: z.array(z.string().min(1)).default([]),
  /** Fixture field names that the fill step leaves unregistered and that the evidence scan leaves out. */
  shown: z.array(z.string().min(1)).default([]),
});
export type RedactionConfig = z.infer<typeof RedactionConfig>;

// the domains the fixture-domain check allows, plus their subdomains
const TEST_EMAIL_DOMAIN = /(?:^|\.)example\.(?:test|com|org|net)$/i;

/** True for example.test, example.com, example.org, example.net and their subdomains. */
export function isTestEmailDomain(domain: string): boolean {
  return TEST_EMAIL_DOMAIN.test(domain);
}

/** An email address, as the default rules read one. */
export const EMAIL_ADDRESS = /[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;

export class Redactor {
  readonly #rules: RedactionRules;
  // what configure added, kept apart from the rules so the trace scrubber can apply the patterns alone
  #configured: { patterns: PatternRule[]; screenshotSelectors: string[] } = { patterns: [], screenshotSelectors: [] };
  // longest first, so a value that contains another registered value is masked whole
  #registered: string[] = [];

  constructor(rules: RedactionRules) {
    this.#rules = rules;
  }

  /**
   * Adds the project's patterns and screenshot selectors to the rules the redactor was built with, replacing what
   * an earlier call added. The patterns must have passed `RedactionConfig`.
   */
  configure(config: Pick<RedactionConfig, "patterns" | "screenshotSelectors">): void {
    this.#configured = {
      patterns: config.patterns.map((source) => ({
        pattern: new RegExp(source, CONFIGURED_PATTERN_FLAGS),
        mask: () => MASK,
      })),
      screenshotSelectors: [...config.screenshotSelectors],
    };
  }

  /** Masks the value and its URL-encoded, form-encoded and base64 forms from now on, if it has 4 characters or more. */
  register(value: string): void {
    if (value.length < MIN_REGISTERED_LENGTH) return;
    const forms = [value, encodeURIComponent(value), formEncoded(value), Buffer.from(value, "utf8").toString("base64")];
    this.#registered = [...new Set([...this.#registered, ...forms])].sort((a, b) => b.length - a.length);
  }

  text(s: string): string {
    // registered values go first so a pattern cannot mask part of one and leave the rest
    const out = this.maskRegistered(s);
    // every pattern reads the same text, so a configured mask cannot cut short an email or a digit run that a
    // default pattern masks; where a configured match overlaps any other match, the whole stretch is masked
    const stretches = joinOverlaps([
      ...matchesOf(out, this.#configured.patterns, true),
      ...matchesOf(out, this.#rules.patterns, false),
    ]);
    return maskStretches(out, stretches, (part, configured) => (configured ? MASK : this.#maskDefaults(part)));
  }

  /** Masks the configured patterns only, for text such as a trace where the default patterns would break ids. */
  maskConfigured(s: string): string {
    return maskStretches(s, joinOverlaps(matchesOf(s, this.#configured.patterns, true)), () => MASK);
  }

  /** Masks registered values only, for text such as a trace where the patterns would mask ids and timestamps. */
  maskRegistered(s: string): string {
    let out = s;
    for (const value of this.#registered) out = out.replaceAll(value, MASK);
    return out;
  }

  /**
   * True when the number's decimal text is a registered value, or a registered all-digit value without its leading
   * zeros, since "012345" sent as a JSON number reads 12345. maskRegistered and text never mask that stripped form.
   */
  isRegisteredNumber(n: number): boolean {
    const text = String(n);
    if (this.#registered.includes(text)) return true;
    // the stripped form needs four digits too, so an OTP such as "000042" leaves every 42 alone
    if (text.length < MIN_REGISTERED_LENGTH) return false;
    return this.#registered.some((value) => /^0+\d+$/.test(value) && value.replace(/^0+/, "") === text);
  }

  value<T>(v: T): T {
    return this.#copy(v) as T;
  }

  selectors(): readonly string[] {
    return [...this.#rules.screenshotSelectors, ...this.#configured.screenshotSelectors];
  }

  // the default patterns in turn, as one stretch can hold an email and a digit run in it
  #maskDefaults(s: string): string {
    let out = s;
    for (const rule of this.#rules.patterns) out = out.replaceAll(rule.pattern, (match) => rule.mask(match));
    return out;
  }

  #copy(v: unknown): unknown {
    if (typeof v === "string") return this.text(v);
    if (typeof v === "number" || typeof v === "bigint") {
      const s = String(v);
      const masked = this.text(s);
      return masked === s ? v : masked;
    }
    if (ArrayBuffer.isView(v)) {
      // bytes such as a request body are read as UTF-8 and become the masked text when anything is masked
      const s = new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      const masked = this.text(s);
      return masked === s ? v : masked;
    }
    if (Array.isArray(v)) return v.map((item) => this.#copy(item));
    if (typeof v !== "object" || v === null || v instanceof Date) return v;
    // fromEntries defines own properties, so a "__proto__" key cannot reach the prototype
    return Object.fromEntries(
      Object.entries(v).map(([key, item]) => [
        this.text(key),
        this.#isSensitive(key) && item != null ? MASK : this.#copy(item),
      ]),
    );
  }

  #isSensitive(key: string): boolean {
    // search ignores lastIndex, so a rule with the g flag cannot skip keys
    return snakeCase(key).search(this.#rules.sensitiveKeys) !== -1;
  }
}

export function defaultRedactionRules(): RedactionRules {
  return {
    // Whole words only, so "shipping" holds no pin. api_key may follow anything, since "XAPIKey" reads
    // as "xapi_key". A bare "seed" is the run's replay seed and stays.
    sensitiveKeys:
      /(?:^|_)(?:token|secret|password|passwd|cookie|authorization|otp|pin|session)s?(?:_|$)|api_?keys?(?:_|$)|(?:^|_)private_?keys?(?:_|$)|_seed(?:_|$)/,
    patterns: [
      { pattern: EMAIL_ADDRESS, mask: maskEmailLocalPart },
      // the date that starts a run id (YYYYMMDD-HHmmss-<4 hex>) stays readable
      { pattern: /(?!\d{8}-\d{6}-[\da-f]{4}\b)\d{8,}/gi, mask: (match) => `••••${match.slice(-4)}` },
    ],
    screenshotSelectors: [],
  };
}

function patternError(source: string): string | undefined {
  try {
    new RegExp(source, CONFIGURED_PATTERN_FLAGS);
  } catch (error) {
    return `not a regular expression: ${(error as Error).message}`;
  }
  // masking runs synchronously on every output line, so a pattern that backtracks for hours would hang the run
  if (repeatsARepeat(source))
    return "repeats a group that holds a repeat, as (\\w+\\s?)+ does, which can take hours on text that almost matches; write it without the nesting";
  return undefined;
}

interface Repeats {
  /** Holds a repeat whose count can vary and can go above one, such as +, * or {1,4}; ? does not count. */
  varies: boolean;
  /** Holds a repeat with no upper bound. */
  unbounded: boolean;
}

/**
 * True when a group that holds a varying repeat is itself repeated without bound, or a group that holds an unbounded
 * repeat is repeated more than once: the shapes that backtrack exponentially, as in (\w+\s?)+ or (\d{1,4})+.
 * The source must be a valid regular expression with the u flag.
 */
function repeatsARepeat(source: string): boolean {
  // one entry per open group, the whole pattern first
  const groups: Repeats[] = [{ varies: false, unbounded: false }];
  // what the group just closed holds, while a repeat may still follow it
  let closed: Repeats | undefined;
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    const repeat = char === "\\" || char === "[" || char === "(" || char === ")" ? undefined : repeatAt(source, at);
    if (repeat !== undefined) {
      if (closed?.unbounded === true && repeat.max > 1) return true;
      if (closed?.varies === true && repeat.max === UNBOUNDED) return true;
      const group = groups.at(-1)!;
      group.varies ||= repeat.max > repeat.min && repeat.max > 1;
      group.unbounded ||= repeat.max === UNBOUNDED;
      at = repeat.end - 1;
    } else if (char === "\\") {
      // \p{L} and \u{1F600} carry braces that are not a repeat
      at = "pPu".includes(source[at + 1] ?? "") && source[at + 2] === "{" ? source.indexOf("}", at) : at + 1;
    } else if (char === "[") {
      // with the u flag a class ends at its first unescaped bracket
      for (at++; source[at] !== "]"; at++) if (source[at] === "\\") at++;
    } else if (char === "(") {
      groups.push({ varies: false, unbounded: false });
      if (source[at + 1] === "?") at = groupBodyStart(source, at) - 1;
    } else if (char === ")") {
      closed = groups.pop()!;
      const outer = groups.at(-1)!;
      outer.varies ||= closed.varies;
      outer.unbounded ||= closed.unbounded;
      continue;
    }
    closed = undefined;
  }
  return false;
}

// the index after "(?:", "(?=", "(?<=", "(?<name>" or a modifier group such as "(?i:"
function groupBodyStart(source: string, open: number): number {
  const named = source[open + 2] === "<" && source[open + 3] !== "=" && source[open + 3] !== "!";
  if (named) return source.indexOf(">", open) + 1;
  let at = open + 2;
  while (!":=!".includes(source[at] ?? ":")) at++;
  return at + 1;
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

function repeatAt(source: string, at: number): { min: number; max: number; end: number } | undefined {
  const char = source[at];
  let repeat: { min: number; max: number; end: number } | undefined;
  if (char === "*") repeat = { min: 0, max: UNBOUNDED, end: at + 1 };
  else if (char === "+") repeat = { min: 1, max: UNBOUNDED, end: at + 1 };
  else if (char === "?") repeat = { min: 0, max: 1, end: at + 1 };
  else if (char === "{") {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
    if (braces === null) return undefined;
    const min = Number(braces[1]);
    const max = braces[2] === undefined ? min : braces[3] === "" ? UNBOUNDED : Number(braces[3]);
    repeat = { min, max, end: at + braces[0].length };
  }
  // a lazy repeat backtracks the same way
  if (repeat !== undefined && source[repeat.end] === "?") repeat.end += 1;
  return repeat;
}

interface Stretch {
  start: number;
  end: number;
  /** A configured pattern matched in it. */
  configured: boolean;
}

// a match counts when it is not empty and its mask changes it, so an email at a test domain is none
function matchesOf(text: string, rules: readonly PatternRule[], configured: boolean): Stretch[] {
  return rules.flatMap((rule) =>
    [...text.matchAll(rule.pattern)]
      .filter(([match]) => match !== "" && rule.mask(match) !== match)
      .map((match) => ({ start: match.index, end: match.index + match[0].length, configured })),
  );
}

function joinOverlaps(matches: readonly Stretch[]): Stretch[] {
  const joined: Stretch[] = [];
  for (const match of matches.toSorted((a, b) => a.start - b.start)) {
    const last = joined.at(-1);
    if (last !== undefined && match.start < last.end) {
      last.end = Math.max(last.end, match.end);
      last.configured ||= match.configured;
    } else joined.push({ ...match });
  }
  return joined;
}

function maskStretches(
  text: string,
  stretches: readonly Stretch[],
  mask: (part: string, configured: boolean) => string,
): string {
  let out = "";
  let at = 0;
  for (const { start, end, configured } of stretches) {
    out += text.slice(at, start) + mask(text.slice(start, end), configured);
    at = end;
  }
  return out + text.slice(at);
}

function maskEmailLocalPart(email: string): string {
  const domain = email.slice(email.indexOf("@") + 1);
  return isTestEmailDomain(domain) ? email : `${MASK}@${domain}`;
}

// how URLSearchParams writes a value: a space becomes "+" and !'()~ are percent-encoded
function formEncoded(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

// "accessToken", "X-Api-Key" and "totpSeed" become "access_token", "x_api_key" and "totp_seed"
function snakeCase(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z\d]+/g, "_")
    .toLowerCase();
}
