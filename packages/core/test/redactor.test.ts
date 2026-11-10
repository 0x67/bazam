import { describe, expect, it } from "vite-plus/test";
import { RedactionConfig, Redactor, defaultRedactionRules } from "../src/redact/index.ts";

function defaultRedactor(): Redactor {
  return new Redactor(defaultRedactionRules());
}

describe("Redactor", () => {
  it("masks registered values and their URL-encoded, form-encoded and base64 forms", () => {
    const redactor = defaultRedactor();
    const secret = "pa ss/w0rd+=!(x)~";
    redactor.register(secret);
    const encoded = encodeURIComponent(secret);
    const form = new URLSearchParams({ secret }).toString();
    const base64 = Buffer.from(secret, "utf8").toString("base64");

    expect(redactor.text(`raw=${secret} query=${encoded} ${form} header=${base64}`)).toBe(
      "raw=[redacted] query=[redacted] secret=[redacted] header=[redacted]",
    );
  });

  it("ignores registered values shorter than four characters", () => {
    const redactor = defaultRedactor();
    redactor.register("abc");

    expect(redactor.text("abc abcd")).toBe("abc abcd");
  });

  it("masks a registered value whole when a pattern also matches part of it", () => {
    const redactor = defaultRedactor();
    redactor.register("ref123456789");

    expect(redactor.text("id ref123456789")).toBe("id [redacted]");
  });

  it("masks registered values in nested strings, numbers and keys of a value", () => {
    const redactor = defaultRedactor();
    redactor.register("482913");
    redactor.register("hunter22");

    expect(redactor.value({ code: 482913, notes: ["typed hunter22"], hunter22: true })).toEqual({
      code: "[redacted]",
      notes: ["typed [redacted]"],
      "[redacted]": true,
    });
  });

  it("returns bytes that hold a registered value as the masked text", () => {
    const redactor = defaultRedactor();
    redactor.register("demo-client-secret");
    const plain = new TextEncoder().encode("grant_type=client_credentials");

    const masked = redactor.value({ body: Buffer.from("client_secret=demo-client-secret"), plain });

    expect(masked).toEqual({ body: "client_secret=[redacted]", plain });
  });

  it("masks sensitive keys", () => {
    const input = {
      user: "ops@example.test",
      accessToken: "abc",
      headers: { Authorization: "Bearer xyz", "X-Api-Key": "k1", accept: "application/json" },
      otp: 123456,
      totpSeed: "GEZDGNBVGY3TQOJQ",
      cookies: [{ name: "sid", value: "s1" }],
      refreshToken: null,
    };

    expect(defaultRedactor().value(input)).toEqual({
      user: "ops@example.test",
      accessToken: "[redacted]",
      headers: { Authorization: "[redacted]", "X-Api-Key": "[redacted]", accept: "application/json" },
      otp: "[redacted]",
      totpSeed: "[redacted]",
      cookies: "[redacted]",
      refreshToken: null,
    });
    expect(input.accessToken).toBe("abc");
  });

  it("masks a passkey's private key under either spelling", () => {
    const input = { passkeys: [{ credentialId: "cred-1", privateKey: "fake-key-a" }], private_key: "fake-key-b" };

    expect(defaultRedactor().value(input)).toEqual({
      passkeys: [{ credentialId: "cred-1", privateKey: "[redacted]" }],
      private_key: "[redacted]",
    });
  });

  it("keeps the replay seed and keys where a sensitive word is only part of another word", () => {
    const input = { seed: 1234, shipping: "express", mapping: "eu", typing: "fast" };

    expect(defaultRedactor().value(input)).toEqual(input);
  });

  it("masks non-test email local parts and long digit runs", () => {
    const redactor = defaultRedactor();

    expect(redactor.text("from ops@mail.invalid to ops@example.test and qa@uat.example.com")).toBe(
      "from [redacted]@mail.invalid to ops@example.test and qa@uat.example.com",
    );
    expect(redactor.text("account 123456789012, ref.123456789, short 1234567")).toBe(
      "account ••••9012, ref.••••6789, short 1234567",
    );
    expect(redactor.value({ account: 123456789012, amount: 12.5 })).toEqual({ account: "••••9012", amount: 12.5 });
  });

  it("masks the whole local part of emails with non-ASCII domains or RFC 5322 characters", () => {
    expect(defaultRedactor().text("anna@müller.de o'brien@corp.io first&last@corp.io")).toBe(
      "[redacted]@müller.de [redacted]@corp.io [redacted]@corp.io",
    );
  });

  it("masks long digit runs that follow a dot, such as dotted phone numbers", () => {
    expect(defaultRedactor().text("call +1.4155552671 or 030.12345678, paid 12345678.50")).toBe(
      "call +1.••••2671 or 030.••••5678, paid ••••5678.50",
    );
  });

  it("keeps run ids readable in markers and run paths", () => {
    const text = "marker case:AUTH-X-001:20261106-164200-ab12 in runs/20261106-164200-ab12/result.json";

    expect(defaultRedactor().text(text)).toBe(text);
  });

  it("maskRegistered masks registered values and leaves digit runs, emails and keys alone", () => {
    const redactor = defaultRedactor();
    redactor.register("otp 424242");
    const line =
      '{"value":"otp 424242","base64":"b3RwIDQyNDI0Mg==","time":1731234567890,"to":"ops@mail.invalid","password":"x"}';

    expect(redactor.maskRegistered(line)).toBe(
      '{"value":"[redacted]","base64":"[redacted]","time":1731234567890,"to":"ops@mail.invalid","password":"x"}',
    );
  });

  it("isRegisteredNumber matches a registered all-digit value without its leading zeros, which text keeps", () => {
    const redactor = defaultRedactor();
    redactor.register("012345");

    expect(redactor.isRegisteredNumber(12345)).toBe(true);
    expect(redactor.maskRegistered("order 12345")).toBe("order 12345");
  });

  it("isRegisteredNumber ignores the leading-zero form when fewer than four digits remain", () => {
    const redactor = defaultRedactor();
    redactor.register("000042");
    redactor.register("00004321");

    expect(redactor.isRegisteredNumber(42)).toBe(false);
    expect(redactor.isRegisteredNumber(4321)).toBe(true);
  });

  it("isRegisteredNumber matches a registered value whole and no other number", () => {
    const redactor = defaultRedactor();
    redactor.register("739150");

    expect(redactor.isRegisteredNumber(739150)).toBe(true);
    expect(redactor.isRegisteredNumber(7391506)).toBe(false);
    expect(redactor.isRegisteredNumber(424242)).toBe(false);
  });

  it("masks every match of a configured pattern whole, with any default match that overlaps it", () => {
    const redactor = defaultRedactor();
    redactor.configure({ patterns: ["ACCT-\\d+", "x*"], screenshotSelectors: [] });

    expect(redactor.text("acct ACCT-123456789 ref 123456789 box")).toBe("acct [redacted] ref ••••6789 bo[redacted]");
    expect(redactor.value({ note: ["ACCT-42"] })).toEqual({ note: ["[redacted]"] });
  });

  it("keeps the default email and digit masks when a configured pattern matches part of an email or a digit run", () => {
    const redactor = defaultRedactor();
    redactor.configure({ patterns: ["\\d{5}", "[a-z0-9-]+\\.internal"], screenshotSelectors: [] });

    expect(redactor.text("mail jane.doe48213@gmail.com, write jane.doe@payments.internal")).toBe(
      "mail [redacted], write [redacted]",
    );
    expect(redactor.value({ pan: "pan 123456789012 end" })).toEqual({ pan: "pan [redacted] end" });
    // an email at a test domain is no default match, so only the configured part goes
    expect(redactor.text("ops48213@example.test")).toBe("ops[redacted]@example.test");
  });

  it("maskConfigured masks the configured patterns and leaves the defaults and registered values alone", () => {
    const redactor = defaultRedactor();
    redactor.register("hunter22");
    redactor.configure({ patterns: ["ACCT-\\d+", "\\d{3}-"], screenshotSelectors: [] });

    expect(redactor.maskConfigured("ACCT-4821 ACCT-482-1 at 1731234567890 to ops@mail.invalid hunter22")).toBe(
      "[redacted] [redacted]1 at 1731234567890 to ops@mail.invalid hunter22",
    );
  });

  it("adds configured screenshot selectors to its own, and a later configure replaces the earlier one", () => {
    const redactor = new Redactor({ ...defaultRedactionRules(), screenshotSelectors: [".base"] });
    redactor.configure({ patterns: ["ACCT-\\d+"], screenshotSelectors: ["#card"] });

    expect(redactor.selectors()).toEqual([".base", "#card"]);

    redactor.configure({ patterns: [], screenshotSelectors: ["#pan"] });

    expect(redactor.selectors()).toEqual([".base", "#pan"]);
    expect(redactor.text("ACCT-42")).toBe("ACCT-42");
  });
});

describe("RedactionConfig", () => {
  it("defaults to no patterns, selectors or shown fields, and refuses a pattern that is not a regular expression", () => {
    expect(RedactionConfig.parse({})).toEqual({ patterns: [], screenshotSelectors: [], shown: [] });

    const result = RedactionConfig.safeParse({ patterns: ["ok-\\d+", "(unclosed"] });

    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["patterns", 1], expect.stringMatching(/^not a regular expression: Invalid regular expression: \/\(unclosed\//)],
    ]);
  });

  it("refuses a pattern that repeats a group holding a repeat, which backtracks exponentially", () => {
    const patterns = [
      "(\\w+\\s?)+$",
      "(\\d{1,4})+",
      "(?:\\d{4}[ -]?){3}\\d{4}",
      "(\\d{1,4}){3}",
      "\\p{L}{2,}",
      "(ref-\\d+)?",
    ];

    const result = RedactionConfig.safeParse({ patterns });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["patterns", 0],
      ["patterns", 1],
    ]);
    expect(result.error?.issues[0]?.message).toMatch(/^repeats a group that holds a repeat, as \(\\w\+\\s\?\)\+ does/);
  });
});
