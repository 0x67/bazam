import { describe, expect, it } from "vite-plus/test";
import {
  HumanOnlyViolation,
  assertHumanOnly,
  builtinKinds,
  humanResolver,
  type ChallengeKindSpec,
  type ChallengeResolver,
} from "../src/challenge/index.ts";

const builtin = (name: string): ChallengeKindSpec => builtinKinds.find((kind) => kind.name === name)!;
// what PluginRegistry.kind returns for a kind config lists under challenges.humanOnly
const lockedTotp: ChallengeKindSpec = { ...builtin("totp"), humanOnly: true };
const codeTyper: ChallengeResolver = {
  name: "code-typer",
  kinds: ["totp", "otp-email", "pin"],
  requires: [],
  automated: true,
  resolve: async () => ({ kind: "value", value: "123456" }),
};

describe("assertHumanOnly", () => {
  it("rejects an automated resolver for a kind config lists as human-only", () => {
    expect(() => assertHumanOnly(lockedTotp, [humanResolver, codeTyper])).toThrow(HumanOnlyViolation);
    expect(() => assertHumanOnly(lockedTotp, [codeTyper])).toThrow('automated resolver "code-typer"');
  });

  it("accepts person resolvers for a human-only kind and automated resolvers for other kinds", () => {
    expect(() => assertHumanOnly(lockedTotp, [humanResolver])).not.toThrow();
    expect(() => assertHumanOnly(builtin("otp-email"), [codeTyper, humanResolver])).not.toThrow();
    expect(() => assertHumanOnly(builtin("pin"), [codeTyper])).not.toThrow();
  });
});
