import { describe, expect, it } from "vitest";
import {
  ChallengeBlocked,
  HumanOnlyViolation,
  builtinKinds,
  chooseResolver,
  humanResolver,
  resolveChallenge,
  type ChallengeAnswer,
  type ChallengeKindSpec,
  type ChallengeRequest,
  type ChallengeResolver,
  type HumanChannel,
  type PersonAnswer,
  type PersonPrompt,
  type ResolverContext,
} from "../src/challenge/index.ts";

const RUN_ID = "20261106-093000-a1b2";

function builtinKind(name: string): ChallengeKindSpec {
  const kind = builtinKinds.find((spec) => spec.name === name);
  if (kind === undefined) throw new Error(`no built-in kind ${name}`);
  return kind;
}

function requestFor(kind: string): ChallengeRequest {
  return { kind, caseId: "AUTH-LOGIN-001", identity: "customer", step: 3, params: { recipient: "ops@example.test" } };
}

interface ChannelSpy extends HumanChannel {
  prompts: PersonPrompt[];
}

function channelAnswering(answer: PersonAnswer): ChannelSpy {
  const prompts: PersonPrompt[] = [];
  return {
    prompts,
    ask: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
  };
}

function context(options: { capabilities?: readonly string[]; channel?: HumanChannel } = {}): ResolverContext {
  return {
    env: { name: "demo", production: false, vars: {}, hosts: new Set(["app.example.test"]), challenges: {}, locale: "en" },
    session: { capabilities: new Set(options.capabilities ?? []), close: async () => {} },
    channel: options.channel ?? channelAnswering({ kind: "timeout" }),
    prompt: { runId: RUN_ID, screenshot: `runs/${RUN_ID}/AUTH-LOGIN-001/02-login.png`, timeoutMs: 60_000 },
    secrets: async (key) => {
      throw new Error(`no secret ${key} in this test`);
    },
    now: () => new Date("2026-11-06T09:30:00.000Z"),
    signal: new AbortController().signal,
  };
}

interface StubOptions {
  requires?: readonly string[];
  /** What resolve returns, or the error it throws. */
  answer?: ChallengeAnswer | Error;
  armError?: Error;
}

/** An automated resolver that appends "arm <name>" and "resolve <name>" to `log`. */
function stubResolver(name: string, options: StubOptions, log: string[] = []): ChallengeResolver {
  return {
    name,
    kinds: ["otp-email", "passkey", "pin"],
    requires: options.requires ?? [],
    automated: true,
    arm: async () => {
      log.push(`arm ${name}`);
      if (options.armError !== undefined) throw options.armError;
    },
    resolve: async () => {
      log.push(`resolve ${name}`);
      if (options.answer instanceof Error) throw options.answer;
      return options.answer;
    },
  };
}

const noTrigger = async (): Promise<void> => {};

describe("resolveChallenge", () => {
  it("skips resolvers missing a capability", async () => {
    const chain = [
      stubResolver("needs-webauthn", { requires: ["webauthn.virtual"], answer: { kind: "value", value: "111111" } }),
      stubResolver("otp-mailpit", { answer: { kind: "value", value: "222222" } }),
    ];

    expect(chooseResolver(chain, new Set())).toBe(chain[1]);
    const resolved = await resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), chain, context(), noTrigger);

    expect(resolved).toEqual({ answer: { kind: "value", value: "222222" }, resolver: "otp-mailpit" });
  });

  it("arms the resolver before the trigger and resolves after it", async () => {
    const log: string[] = [];
    const chain = [stubResolver("otp-mailpit", { answer: { kind: "value", value: "222222" } }, log)];

    await resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), chain, context(), async () => {
      log.push("trigger");
    });

    expect(log).toEqual(["arm otp-mailpit", "trigger", "resolve otp-mailpit"]);
  });

  it("records the resolver used", async () => {
    const chain = [stubResolver("otp-mailpit", { answer: { kind: "value", value: "222222" } }), humanResolver];

    const resolved = await resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), chain, context(), noTrigger);

    expect(resolved.resolver).toBe("otp-mailpit");
  });

  it("falls back to human after trigger for otp-email", async () => {
    const channel = channelAnswering({ kind: "value", value: "333333" });
    const chain = [stubResolver("otp-mailpit", {}), humanResolver];

    const resolved = await resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), chain, context({ channel }), noTrigger);

    expect(resolved).toEqual({ answer: { kind: "value", value: "333333" }, resolver: "human" });
    expect(channel.prompts).toEqual([
      expect.objectContaining({
        id: "AUTH-LOGIN-001-3-otp-email",
        runId: RUN_ID,
        caseId: "AUTH-LOGIN-001",
        ask: "value",
        screenshot: `runs/${RUN_ID}/AUTH-LOGIN-001/02-login.png`,
        timeoutMs: 60_000,
      }),
    ]);
  });

  it("blocks instead of falling back for passkey", async () => {
    const channel = channelAnswering({ kind: "done" });
    const chain = [stubResolver("passkey-virtual", { requires: ["webauthn.virtual"], answer: new Error("no credential was used") }), humanResolver];
    const ctx = context({ capabilities: ["webauthn.virtual"], channel });

    const resolving = resolveChallenge(requestFor("passkey"), builtinKind("passkey"), chain, ctx, noTrigger);

    await expect(resolving).rejects.toThrow(ChallengeBlocked);
    await expect(resolving).rejects.toThrow('resolver "passkey-virtual" failed: no credential was used');
    expect(channel.prompts).toEqual([]);
  });

  it("gives way to the next resolver when one cannot arm, before the trigger runs", async () => {
    const log: string[] = [];
    const chain = [
      stubResolver("otp-mailpit", { armError: new Error("mailpit is down") }, log),
      stubResolver("otp-http-hook", { answer: { kind: "value", value: "444444" } }, log),
    ];

    const resolved = await resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), chain, context(), async () => {
      log.push("trigger");
    });

    expect(resolved.resolver).toBe("otp-http-hook");
    expect(log).toEqual(["arm otp-mailpit", "arm otp-http-hook", "trigger", "resolve otp-http-hook"]);
  });

  it("blocks naming the missing capability when no resolver can run", async () => {
    const chain = [stubResolver("passkey-virtual", { requires: ["webauthn.virtual"] })];

    await expect(resolveChallenge(requestFor("passkey"), builtinKind("passkey"), chain, context(), noTrigger)).rejects.toThrow(
      "no resolver for challenge passkey can run on this driver: passkey-virtual needs webauthn.virtual",
    );
  });

  it("asks a person to act and confirm for pin", async () => {
    const channel = channelAnswering({ kind: "done" });

    const resolved = await resolveChallenge(requestFor("pin"), builtinKind("pin"), [humanResolver], context({ channel }), noTrigger);

    expect(resolved).toEqual({ answer: { kind: "done" }, resolver: "human" });
    expect(channel.prompts[0]?.ask).toBe("action");
    expect(channel.prompts[0]?.steps).toContain("Type the pin only into the app, never into the answer.");
  });

  it("never returns a value for pin, even when the person sends one", async () => {
    const channel = channelAnswering({ kind: "value", value: "4321" });

    const error = await resolveChallenge(requestFor("pin"), builtinKind("pin"), [humanResolver], context({ channel }), noTrigger).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ChallengeBlocked);
    expect((error as Error).message).not.toContain("4321");
  });

  it("refuses an automated resolver for pin before arming it", async () => {
    const log: string[] = [];
    const chain = [stubResolver("pin-typer", { answer: { kind: "done" } }, log), humanResolver];

    await expect(resolveChallenge(requestFor("pin"), builtinKind("pin"), chain, context(), noTrigger)).rejects.toThrow(HumanOnlyViolation);
    expect(log).toEqual([]);
  });

  it("blocks with the person's note when the person answers blocked", async () => {
    const channel = channelAnswering({ kind: "verdict", verdict: "blocked", note: "no phone at hand" });

    await expect(
      resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), [humanResolver], context({ channel }), noTrigger),
    ).rejects.toThrow('resolver "human" failed: the person answered blocked: no phone at hand');
  });

  it("blocks when the person gives no answer in time", async () => {
    const channel = channelAnswering({ kind: "timeout" });
    const chain = [stubResolver("otp-mailpit", {}), humanResolver];

    await expect(
      resolveChallenge(requestFor("otp-email"), builtinKind("otp-email"), chain, context({ channel }), noTrigger),
    ).rejects.toThrow('resolver "otp-mailpit" found no answer; then resolver "human" failed: no answer from a person within 60 s');
  });
});
