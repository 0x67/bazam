import type { PersonAnswer, PersonPrompt } from "./human.ts";
import { takesValue, type ChallengeKindSpec } from "./kinds.ts";
import type { ChallengeAnswer, ChallengeRequest, ChallengeResolver, ResolverContext } from "./resolver.ts";

type Ask = "value" | "action";

/** Hands any challenge kind to a person. A human-only kind gets an action and a confirmation, never a value. */
export const humanResolver: ChallengeResolver = {
  name: "human",
  kinds: ["*"],
  requires: [],
  automated: false,
  async resolve(request, ctx, kind) {
    const ask: Ask = takesValue(kind) ? "value" : "action";
    const answer = await ctx.channel.ask(challengePrompt(request, ctx, kind, ask), ctx.signal);
    return challengeAnswer(answer, ask, ctx.prompt.timeoutMs);
  },
};

function challengePrompt(request: ChallengeRequest, ctx: ResolverContext, kind: ChallengeKindSpec, ask: Ask): PersonPrompt {
  return {
    id: `${request.caseId}-${request.step}-${request.kind}`,
    caseId: request.caseId,
    ask,
    title: `${kind.name} challenge at step ${request.step}`,
    steps: challengeSteps(request.identity, kind, ask),
    ...ctx.prompt,
  };
}

function challengeSteps(identity: string, kind: ChallengeKindSpec, ask: Ask): string[] {
  if (ask === "value") return [`Get the ${kind.name} code for ${identity}.`, "Answer with the code."];
  const act = `Complete the ${kind.name} step in the app as ${identity}.`;
  const done = "Answer done when the app accepts it.";
  return kind.humanOnly ? [act, `Type the ${kind.name} only into the app, never into the answer.`, done] : [act, done];
}

function challengeAnswer(answer: PersonAnswer, ask: Ask, timeoutMs: number): ChallengeAnswer {
  switch (answer.kind) {
    case "value":
      // the value is dropped unread, so a human-only kind never carries a secret back
      if (ask === "value") return { kind: "value", value: answer.value };
      throw new Error("the person sent a value, but this challenge only takes done");
    case "done":
      if (ask === "action") return { kind: "done" };
      throw new Error("the person answered done, but this challenge needs a value");
    case "verdict":
      if (answer.verdict === "pass" && ask === "action") return { kind: "done" };
      if (answer.verdict === "pass") throw new Error("the person answered pass, but this challenge needs a value");
      throw new Error(`the person answered ${answer.verdict}${answer.note === "" ? "" : `: ${answer.note}`}`);
    case "timeout":
      throw new Error(`no answer from a person within ${Math.round(timeoutMs / 1000)} s`);
  }
}
