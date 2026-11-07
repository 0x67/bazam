import type { Capability, DriverSession } from "../driver/index.ts";
import type { GuardedHttp } from "../driver/http.ts";
import type { Environment } from "../env/index.ts";
import type { HumanChannel, PersonPrompt } from "./human.ts";
import { takesValue, type ChallengeKindSpec } from "./kinds.ts";
import { assertHumanOnly } from "./policy.ts";

export interface ChallengeRequest {
  kind: string;
  caseId: string;
  identity: string;
  step: number;
  params: Record<string, string>;
}

export type ChallengeAnswer = { kind: "value"; value: string } | { kind: "done" };

export interface ResolverContext {
  env: Environment;
  /** For resolvers that read an API, such as a mail inbox; limited to the env's hosts. */
  http: GuardedHttp;
  session?: DriverSession;
  channel: HumanChannel;
  /** What a resolver that asks a person copies into its prompt beside the question. */
  prompt: Pick<PersonPrompt, "runId" | "screenshot" | "timeoutMs">;
  /** The project's state folder, where resolvers keep per-identity state such as virtual passkeys. */
  stateDir: string;
  secrets(key: string): Promise<string>;
  now(): Date;
  signal: AbortSignal;
}

export interface ChallengeResolver {
  name: string;
  /** The challenge kinds it answers; "*" answers every kind. */
  kinds: readonly string[];
  /** A chain skips the resolver on a driver that lacks any of these. */
  requires: readonly Capability[];
  /** False for a resolver that hands the challenge to a person. */
  automated: boolean;
  /** Runs before the trigger, for example to note the mail already in the inbox so it is ignored. */
  arm?(request: ChallengeRequest, ctx: ResolverContext): Promise<void>;
  /** Undefined when it found no answer. */
  resolve(request: ChallengeRequest, ctx: ResolverContext, kind: ChallengeKindSpec): Promise<ChallengeAnswer | undefined>;
}

/** The case cannot go on: no resolver could run, or the chain gave no answer. */
export class ChallengeBlocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ChallengeBlocked";
  }
}

export interface ResolvedChallenge {
  answer: ChallengeAnswer;
  /** The name of the resolver that answered. */
  resolver: string;
}

export function chooseResolver(
  chain: readonly ChallengeResolver[],
  capabilities: ReadonlySet<Capability>,
): ChallengeResolver | undefined {
  return chain.find((resolver) => canRun(resolver, capabilities));
}

/**
 * Arms the first resolver that can run here, runs the trigger, then asks it to resolve.
 * After the trigger, only a person resolver from the chain may take over from a failed automated one,
 * and only when the kind allows it.
 */
export async function resolveChallenge(
  request: ChallengeRequest,
  kind: ChallengeKindSpec,
  chain: readonly ChallengeResolver[],
  ctx: ResolverContext,
  runTrigger: () => Promise<void>,
): Promise<ResolvedChallenge> {
  assertHumanOnly(kind, chain);
  const capabilities: ReadonlySet<Capability> = ctx.session?.capabilities ?? new Set();
  const runnable = chain.filter((resolver) => canRun(resolver, capabilities));
  if (runnable.length === 0) throw new ChallengeBlocked(noRunnableReason(kind, chain, capabilities, ctx.env));

  // nothing has happened in the app before the trigger, so a resolver that cannot arm gives way to the next
  let armed: ChallengeResolver | undefined;
  let reason = "";
  for (const resolver of runnable) {
    try {
      await resolver.arm?.(request, ctx);
      armed = resolver;
      break;
    } catch (error) {
      reason = `resolver "${resolver.name}" could not arm: ${messageOf(error)}`;
    }
  }
  if (armed === undefined) throw new ChallengeBlocked(reason);

  await runTrigger();
  const first = await attempt(armed, request, kind, ctx);
  if (typeof first !== "string") return first;

  const person = armed.automated && kind.fallbackAfterTrigger ? runnable.find((resolver) => !resolver.automated) : undefined;
  if (person === undefined) throw new ChallengeBlocked(first);
  const second = await attempt(person, request, kind, ctx);
  if (typeof second !== "string") return second;
  throw new ChallengeBlocked(`${first}; then ${second}`);
}

function canRun(resolver: ChallengeResolver, capabilities: ReadonlySet<Capability>): boolean {
  return resolver.requires.every((capability) => capabilities.has(capability));
}

/** Returns the answer, or the reason the resolver gave none. */
async function attempt(
  resolver: ChallengeResolver,
  request: ChallengeRequest,
  kind: ChallengeKindSpec,
  ctx: ResolverContext,
): Promise<ResolvedChallenge | string> {
  let answer: ChallengeAnswer | undefined;
  try {
    answer = await resolver.resolve(request, ctx, kind);
  } catch (error) {
    return `resolver "${resolver.name}" failed: ${messageOf(error)}`;
  }
  if (answer === undefined) return `resolver "${resolver.name}" found no answer`;
  // checked here so that no resolver, built in or from a plugin, can hand back a value for a human-only kind
  const expected = takesValue(kind) ? "value" : "done";
  if (answer.kind !== expected) return `resolver "${resolver.name}" answered ${answer.kind}, but ${kind.name} takes ${expected}`;
  return { answer, resolver: resolver.name };
}

function noRunnableReason(
  kind: ChallengeKindSpec,
  chain: readonly ChallengeResolver[],
  capabilities: ReadonlySet<Capability>,
  env: Environment,
): string {
  if (chain.length === 0) return `env ${env.name} has no resolver chain for challenge ${kind.name}`;
  const missing = chain.map(
    (resolver) => `${resolver.name} needs ${resolver.requires.filter((capability) => !capabilities.has(capability)).join(", ")}`,
  );
  return `no resolver for challenge ${kind.name} can run on this driver: ${missing.join("; ")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
