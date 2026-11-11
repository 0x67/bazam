import { BRAND } from "@bazam/core/brand";
import { stepKind, type ChallengeStep, type SourceSpan, type Step } from "@bazam/core/case";
import type { ChallengeResolver } from "@bazam/core/challenge";
import type { CheckIssue, CheckRule } from "@bazam/core/check";
import { findPlaceholders } from "@bazam/core/env";
import type { Project } from "@bazam/core/project";

const DECLARED_RULE = "pin-secret-declared";

/**
 * Answers `pin` with the value of the secret that `params.secret` names, so no person types the PIN.
 * A secret no provider holds rejects with `SecretMissing`, which blocks the case.
 */
export const pinSecretResolver: ChallengeResolver = {
  name: "pin-secret",
  kinds: ["pin"],
  requires: [],
  automated: true,
  async resolve(request, ctx) {
    const name = request.params["secret"];
    if (name === undefined || name === "")
      throw new Error("pin-secret needs params.secret, the name of the secret that holds the PIN");
    return { kind: "value", value: await ctx.secrets(name) };
  },
};

/**
 * pin-secret types the secret into the app as it is, so its `params.secret` must be a name that
 * secrets.names declares, as for a `${secret.NAME}` placeholder.
 */
export const pinSecretDeclared: CheckRule = {
  id: DECLARED_RULE,
  check: (project) => [
    ...project.cases.flatMap(({ spec, source }) =>
      undeclared(project, spec.id, source, [...spec.steps, ...spec.checks, ...spec.finally]),
    ),
    ...[...project.flows.values()].flatMap(({ name, source, steps }) =>
      undeclared(project, `flow ${name}`, source, steps),
    ),
  ],
};

function undeclared(
  project: Project,
  owner: string,
  at: SourceSpan,
  steps: readonly Step[],
): CheckIssue[] {
  return steps.flatMap((step) => {
    const name = undeclaredSecret(project, step);
    if (name === undefined) return [];
    return [
      {
        ruleId: DECLARED_RULE,
        severity: "error",
        file: at.file,
        line: at.line,
        message: `${owner} answers pin from secret ${name}, which ${BRAND.configFile} does not declare`,
        fix: `Add ${name} to secrets.names in ${BRAND.configFile}, or name a declared secret in params.secret.`,
      },
    ];
  });
}

/** A placeholder in the name resolves only at run time, so it is left to the run. */
function undeclaredSecret(project: Project, step: Step): string | undefined {
  if (stepKind(step) !== "challenge") return undefined;
  const { kind, params } = step["challenge"] as ChallengeStep;
  const name = params?.["secret"];
  if (
    name === undefined ||
    findPlaceholders(name).length > 0 ||
    project.config.secrets.names.includes(name)
  ) {
    return undefined;
  }
  const chains = Object.values(project.config.envs).map(({ challenges }) => challenges[kind] ?? []);
  return chains.some((chain) => chain.includes(pinSecretResolver.name)) ? name : undefined;
}
