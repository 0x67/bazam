import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { totpCode, totpResolver } from "../src/totp.ts";
import { builtinKind, challenge, context } from "./support.ts";

// base32 of the RFC 6238 SHA-1 test key "12345678901234567890"
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TOTP = builtinKind("totp");

function resolverContext(nowMs: number, signal = new AbortController().signal) {
  return context({
    now: () => new Date(nowMs),
    signal,
    secrets: async (key) => {
      if (key === "DEMO_TOTP_SEED") return SEED;
      throw new Error(`no secret ${key} in this test`);
    },
  });
}

describe("totpCode", () => {
  // RFC 6238 appendix B lists 8 digit codes; a 6 digit code is the last 6 of them
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the RFC 6238 SHA-1 vector at %i seconds", (seconds, rfcCode) => {
    expect(totpCode(SEED, new Date(seconds * 1000))).toBe(rfcCode.slice(-6));
  });

  it("reads a seed in lower case with spaces and padding", () => {
    expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====", new Date(59_000))).toBe("287082");
  });

  it("rejects a seed that is not base32 without echoing it", () => {
    expect(() => totpCode("GEZD-1890", new Date(59_000))).toThrow(/^the TOTP seed is not base32$/);
  });
});

describe("totpResolver", () => {
  it("returns the current code from the secret params.seed names when three seconds remain", async () => {
    const answer = await totpResolver.resolve(challenge("totp", { seed: "DEMO_TOTP_SEED" }), resolverContext(57_000), TOTP);
    expect(answer).toEqual({ kind: "value", value: "287082" });
  });

  it("waits for the next step when fewer than three seconds remain", async () => {
    const started = performance.now();
    const answer = await totpResolver.resolve(challenge("totp", { seed: "DEMO_TOTP_SEED" }), resolverContext(59_750), TOTP);
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    expect(answer).toEqual({ kind: "value", value: totpCode(SEED, new Date(60_000)) });
    expect(answer).not.toEqual({ kind: "value", value: "287082" });
  });

  it("stops waiting when the run aborts", async () => {
    const run = new AbortController();
    const answer = totpResolver.resolve(challenge("totp", { seed: "DEMO_TOTP_SEED" }), resolverContext(58_000, run.signal), TOTP);
    run.abort();
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
  });
});
