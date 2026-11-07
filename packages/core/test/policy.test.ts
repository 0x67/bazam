import { describe, expect, it } from "vite-plus/test";
import {
  HumanOnlyViolation,
  assertHumanOnly,
  builtinKinds,
  humanResolver,
  type ChallengeResolver,
} from "../src/challenge/index.ts";

const pin = builtinKinds.find((kind) => kind.name === "pin")!;
const otpEmail = builtinKinds.find((kind) => kind.name === "otp-email")!;
const pinTyper: ChallengeResolver = {
  name: "pin-typer",
  kinds: ["pin", "otp-email"],
  requires: [],
  automated: true,
  resolve: async () => ({ kind: "done" }),
};

describe("assertHumanOnly", () => {
  it("rejects an automated resolver for pin", () => {
    expect(() => assertHumanOnly(pin, [humanResolver, pinTyper])).toThrow(HumanOnlyViolation);
    expect(() => assertHumanOnly(pin, [pinTyper])).toThrow('automated resolver "pin-typer"');
  });

  it("accepts person resolvers for pin and automated resolvers for other kinds", () => {
    expect(() => assertHumanOnly(pin, [humanResolver])).not.toThrow();
    expect(() => assertHumanOnly(otpEmail, [pinTyper, humanResolver])).not.toThrow();
  });
});
