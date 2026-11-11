import { describe, expect, it } from "vite-plus/test";
import { GuidedBlocked, checkGuidedOutcome, type PersonAnswer } from "../src/challenge/index.ts";

const NAME = "signed in with MPIN and face check";
const EXPECTED = "Dashboard with holdings";
const pass: PersonAnswer = { kind: "verdict", verdict: "pass", note: "" };

describe("checkGuidedOutcome", () => {
  it("pass with a failed observation is a failed check", () => {
    const check = checkGuidedOutcome(NAME, EXPECTED, pass, { ok: false, observed: "GET /me 401" });

    expect(check).toEqual({
      name: NAME,
      kind: "guided",
      expected: EXPECTED,
      observed: "pass; observed: GET /me 401",
      ok: false,
      hint: "person answered pass but the observed state disagrees",
    });
  });

  it("passes when the person answered pass and the observation agrees", () => {
    const check = checkGuidedOutcome(
      NAME,
      EXPECTED,
      { ...pass, note: "holdings shown" },
      { ok: true, observed: "GET /me 200" },
    );

    expect(check).toMatchObject({
      ok: true,
      observed: "pass: holdings shown; observed: GET /me 200",
    });
    expect(check.hint).toBeUndefined();
  });

  it("fails on a fail verdict even when the observation looks fine", () => {
    const check = checkGuidedOutcome(
      NAME,
      EXPECTED,
      { kind: "verdict", verdict: "fail", note: "face check looped" },
      { ok: true, observed: "GET /me 200" },
    );

    expect(check).toMatchObject({
      ok: false,
      observed: "fail: face check looped; observed: GET /me 200",
    });
  });

  it("blocks on a blocked verdict or a missing verdict", () => {
    expect(() =>
      checkGuidedOutcome(
        NAME,
        EXPECTED,
        { kind: "verdict", verdict: "blocked", note: "no device" },
        undefined,
      ),
    ).toThrow(new GuidedBlocked("person: blocked: no device"));
    expect(() => checkGuidedOutcome(NAME, EXPECTED, { kind: "timeout" }, undefined)).toThrow(
      GuidedBlocked,
    );
    expect(() => checkGuidedOutcome(NAME, EXPECTED, { kind: "done" }, undefined)).toThrow(
      GuidedBlocked,
    );
  });
});
