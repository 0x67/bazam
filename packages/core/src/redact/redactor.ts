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

const MASK = "[redacted]";
const MIN_REGISTERED_LENGTH = 4;

// the domains the fixture-domain check allows, plus their subdomains
const TEST_EMAIL_DOMAIN = /(?:^|\.)example\.(?:test|com|org|net)$/i;

export class Redactor {
  readonly #rules: RedactionRules;
  // longest first, so a value that contains another registered value is masked whole
  #registered: string[] = [];

  constructor(rules: RedactionRules) {
    this.#rules = rules;
  }

  /** Also masks the value's URL-encoded, form-encoded and base64 forms. */
  register(value: string): void {
    if (value.length < MIN_REGISTERED_LENGTH) return;
    const forms = [value, encodeURIComponent(value), formEncoded(value), Buffer.from(value, "utf8").toString("base64")];
    this.#registered = [...new Set([...this.#registered, ...forms])].sort((a, b) => b.length - a.length);
  }

  text(s: string): string {
    // registered values go first so a pattern cannot mask part of one and leave the rest
    let out = this.maskRegistered(s);
    for (const rule of this.#rules.patterns) out = out.replaceAll(rule.pattern, (match) => rule.mask(match));
    return out;
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
    return this.#rules.screenshotSelectors;
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
      /(?:^|_)(?:token|secret|password|passwd|cookie|authorization|otp|pin|session)s?(?:_|$)|api_?keys?(?:_|$)|_seed(?:_|$)/,
    patterns: [
      { pattern: /[\p{L}\p{N}!#$%&'*+\/=?^_`{|}~.-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu, mask: maskEmailLocalPart },
      // the date that starts a run id (YYYYMMDD-HHmmss-<4 hex>) stays readable
      { pattern: /(?!\d{8}-\d{6}-[\da-f]{4}\b)\d{8,}/gi, mask: (match) => `••••${match.slice(-4)}` },
    ],
    screenshotSelectors: [],
  };
}

function maskEmailLocalPart(email: string): string {
  const domain = email.slice(email.indexOf("@") + 1);
  return TEST_EMAIL_DOMAIN.test(domain) ? email : `${MASK}@${domain}`;
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
