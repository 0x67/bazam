import type { ChallengeKindSpec } from "./kinds.ts";
import type { ChallengeResolver } from "./resolver.ts";

/** An automated resolver sits in the chain of a human-only kind. */
export class HumanOnlyViolation extends Error {
  readonly kind: string;
  readonly resolver: string;

  constructor(kind: string, resolver: string) {
    super(
      `challenge kind ${kind} is human-only, so automated resolver "${resolver}" cannot be in its chain`,
    );
    this.name = "HumanOnlyViolation";
    this.kind = kind;
    this.resolver = resolver;
  }
}

export function assertHumanOnly(
  kind: ChallengeKindSpec,
  chain: readonly ChallengeResolver[],
): void {
  if (!kind.humanOnly) return;
  const automated = chain.find((resolver) => resolver.automated);
  if (automated !== undefined) throw new HumanOnlyViolation(kind.name, automated.name);
}
