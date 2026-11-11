// The value forms and token rules of the CI secret scan (scripts/secret-scan.ts) and the evidence scan.

// the redactor ignores shorter values, so they may show up anywhere
export const MIN_SCANNED = 4;
// A shorter form can occur by chance: inside a number a trace keeps (a timestamp that holds a 4-digit PIN), or as
// random bytes in an image, whose compressed pixels never hold drawn text anyway. Elsewhere it counts only as a
// whole token, and images are searched only for longer forms.
export const MIN_ANYWHERE = 8;
export const RUN_ID = /\d{8}-\d{6}-[\da-f]{4}/g;
// a JSON string escape, and a percent escape of an ASCII character
export const JSON_ESCAPE = /\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g;
const JSON_ESCAPED: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
export const PERCENT_ESCAPE = /%[0-7][\da-fA-F]/g;
// enough for JSON inside a JSON string and for a URL encoded twice
export const MAX_DECODE_ROUNDS = 3;

export interface Secret {
  name: string;
  /** Forms of MIN_ANYWHERE or more characters, searched for anywhere. */
  long: string[];
  /** Shorter forms, searched for as whole tokens outside images. */
  short: RegExp[];
}

export function secretOf(name: string, values: readonly string[]): Secret {
  const forms = [
    ...new Set(values.filter((value) => value.length >= MIN_SCANNED).flatMap(encodedForms)),
  ];
  return {
    name,
    long: forms.filter((form) => form.length >= MIN_ANYWHERE),
    short: forms.filter((form) => form.length < MIN_ANYWHERE).map(asToken),
  };
}

// the forms the redactor masks (see packages/core/src/redact/redactor.ts::Redactor.register)
export function encodedForms(value: string): string[] {
  const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
  return [
    value,
    encodeURIComponent(value),
    formEncoded,
    Buffer.from(value, "utf8").toString("base64"),
  ];
}

export function unescaped(text: string): string {
  let out = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = out
      .replace(JSON_ESCAPE, (escape) =>
        escape[1] === "u"
          ? String.fromCharCode(Number.parseInt(escape.slice(2), 16))
          : (JSON_ESCAPED[escape.slice(1)] ?? escape.slice(1)),
      )
      .replace(PERCENT_ESCAPE, (escape) =>
        String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
      );
    if (next === out) break;
    out = next;
  }
  return out;
}

// not joined to a letter or a digit, nor to a digit through a decimal point, so 12.2468 and 2468.5 are one number
export function asToken(form: string): RegExp {
  const escaped = form.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}\\.)${escaped}(?![\\p{L}\\p{N}]|\\.\\p{N})`, "u");
}

// also searches the text with its escapes undone, so a short value right after \n or %3D is the whole token it is
export function textHits(text: string, secrets: readonly Secret[]): string[] {
  const views = [...new Set([text, unescaped(text)])];
  return secrets
    .filter((secret) =>
      views.some(
        (view) =>
          secret.long.some((form) => view.includes(form)) ||
          secret.short.some((token) => token.test(view)),
      ),
    )
    .map((secret) => secret.name);
}
