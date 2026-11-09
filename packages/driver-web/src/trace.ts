import type { Redactor } from "@bazam/core/redact";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const MASK = "[redacted]";
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);
// arrays of { name, value } whose every value is a credential
const CREDENTIAL_ARRAYS: ReadonlySet<string> = new Set(["cookies", "localStorage"]);

/**
 * Masks credentials in a Playwright trace zip: header values by header name, every cookie and localStorage value,
 * the redactor's registered values in all text and JSON numbers, and its configured patterns in all text. Binary
 * entries and entry names stay as they are.
 */
export function scrubTrace(zip: Uint8Array, redactor: Redactor): Uint8Array {
  const scrubber = new TraceScrubber(redactor);
  const entries: Zippable = {};
  for (const [name, bytes] of Object.entries(unzipSync(zip))) entries[name] = scrubber.entry(bytes);
  return zipSync(entries);
}

class TraceScrubber {
  readonly #redactor: Redactor;
  readonly #sensitiveHeaders = new Map<string, boolean>();

  constructor(redactor: Redactor) {
    this.#redactor = redactor;
  }

  entry(bytes: Uint8Array): Uint8Array {
    const text = utf8(bytes);
    if (text === undefined) return bytes;
    const scrubbed = this.#text(text);
    return scrubbed === text ? bytes : strToU8(scrubbed);
  }

  #text(text: string): string {
    // trace.trace and trace.network hold one JSON event per line; parsing line by line first keeps the line breaks
    const lines = text.split("\n").map((line) => ({ line, parsed: parseJson(line) }));
    const isJsonLines =
      lines.some(({ line }) => line !== "") && lines.every(({ line, parsed }) => line === "" || parsed.ok);
    if (isJsonLines)
      return lines.map(({ line, parsed }) => (parsed.ok ? this.#json(line, parsed.value) : line)).join("\n");
    const whole = parseJson(text);
    return whole.ok ? this.#json(text, whole.value) : this.#mask(text);
  }

  // the default patterns stay out, since they would break timestamps and ids
  #mask(text: string): string {
    return this.#redactor.maskConfigured(this.#redactor.maskRegistered(text));
  }

  /** The scrubbed JSON, or the text as it was when scrubbing changed nothing. */
  #json(text: string, value: unknown): string {
    const scrubbed = JSON.stringify(this.#value(value));
    return scrubbed === JSON.stringify(value) ? text : scrubbed;
  }

  // registered values are masked inside strings, so a value that is also a run of digits cannot break a JSON number
  #value(value: unknown): unknown {
    if (typeof value === "string") return this.#mask(this.#jsonString(value));
    // a number is masked only when it is a registered value whole, since timestamps may contain a short code
    if (typeof value === "number") return this.#redactor.isRegisteredNumber(value) ? MASK : value;
    if (Array.isArray(value)) return value.map((item) => this.#value(item));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.#value(this.#maskCredentials(key, item))]),
    );
  }

  // a string can hold a JSON body, such as one posted as form-urlencoded, which Playwright records as a params name,
  // where a registered value sent as a number has lost its leading zeros; the string is rewritten only when scrubbing
  // its parsed form masks something
  #jsonString(text: string): string {
    if (!/^\s*[[{]/.test(text)) return text;
    const parsed = parseJson(text);
    return parsed.ok ? this.#json(text, parsed.value) : text;
  }

  #maskCredentials(key: string, item: unknown): unknown {
    if (!Array.isArray(item)) return item;
    if (key === "headers")
      return item.map((header) =>
        isPair(header) && this.#isSensitiveHeader(header.name) ? { ...header, value: MASK } : header,
      );
    if (CREDENTIAL_ARRAYS.has(key)) return item.map((pair) => (isPair(pair) ? { ...pair, value: MASK } : pair));
    return item;
  }

  #isSensitiveHeader(name: string): boolean {
    const lower = name.toLowerCase();
    let sensitive = this.#sensitiveHeaders.get(lower);
    if (sensitive === undefined) {
      // the redactor keeps its key rule to itself, so ask it to mask a value under this name
      sensitive = CREDENTIAL_HEADERS.has(lower) || Object.values(this.#redactor.value({ [lower]: "x" }))[0] !== "x";
      this.#sensitiveHeaders.set(lower, sensitive);
    }
    return sensitive;
  }
}

function isPair(value: unknown): value is { name: string; value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    "value" in value
  );
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM keeps a byte order mark in the text, so an unchanged entry encodes back to the same bytes
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
