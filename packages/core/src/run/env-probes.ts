import type { CaseSpec, LoadedCase } from "../case/index.ts";
import { ConnectionFailed, type GuardedHttp } from "../driver/index.ts";
import type { EnvProbe, Environment } from "../env/index.ts";
import type { Project } from "../project.ts";
import { messageOf } from "./outcome.ts";
import { caseSteps, finallySteps, type RunPlan } from "./plan.ts";

const PROBE_TIMEOUT_MS = 5_000;
const NO_ANSWER = " got no answer: ";
const ENV_PLACEHOLDER = /\$\{env\.([^}]*)\}/g;
const URL_TEXT = /https?:\/\/[^\s"'<>(){}[\],;]+/g;
const URL_TRAILING_PUNCTUATION = /[.:!?]+$/;

export interface ProbeFailure {
  host: string;
  reason: string;
}

/**
 * Sends each probe once, with no credentials, no redirects followed and a 5 s limit. A probe the run's cancel stopped
 * does not fail, so its cases end "run cancelled" like every other case.
 */
export async function probeEnv(
  env: Environment,
  http: GuardedHttp,
  signal: AbortSignal,
): Promise<ProbeFailure[]> {
  const happened = await Promise.all(env.probes.map((probe) => sendProbe(probe, http, signal)));
  const failures: ProbeFailure[] = [];
  env.probes.forEach((probe, index) => {
    const what = happened[index];
    if (what !== undefined)
      failures.push({
        host: probe.url.hostname,
        reason: `${probe.request} failed: ${what}; ${probe.hint}`,
      });
  });
  return failures;
}

/** What went wrong with the probe, or undefined when the host answered as expected. */
async function sendProbe(
  probe: EnvProbe,
  http: GuardedHttp,
  signal: AbortSignal,
): Promise<string | undefined> {
  const limit = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const { status } = await http.send({
      method: probe.method,
      url: probe.url,
      headers: new Headers(),
      redirect: "manual",
      signal: AbortSignal.any([signal, limit]),
    });
    const ok = probe.status === undefined ? status >= 200 && status < 300 : status === probe.status;
    return ok ? undefined : `answered ${status}`;
  } catch (error) {
    if (signal.aborted) return undefined;
    if (limit.aborted) return `timed out after ${PROBE_TIMEOUT_MS / 1000} s`;
    if (!(error instanceof ConnectionFailed)) return messageOf(error);
    // the message reads "<request> got no answer: <reason>"
    return error.message.slice(error.message.indexOf(NO_ANSWER) + NO_ANSWER.length);
  }
}

/** The hosts of the URLs a case's steps, checks, finally steps and identities' auth settings name, env placeholders filled. */
export function caseHosts(
  spec: CaseSpec,
  project: Project,
  env: Environment,
  identities: readonly string[],
): Set<string> {
  const hosts = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.replace(
        ENV_PLACEHOLDER,
        (placeholder, name: string) => env.vars[name] ?? placeholder,
      );
      for (const [match] of text.matchAll(URL_TEXT)) {
        const url = match.replace(URL_TRAILING_PUNCTUATION, "");
        if (URL.canParse(url)) hosts.add(new URL(url).hostname);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  visit(caseSteps(spec, project.flows));
  visit(finallySteps(spec, project.flows));
  for (const name of identities) {
    for (const auth of Object.values(project.config.identities[name]?.auth ?? {}))
      if ("with" in auth) visit(auth.with);
  }
  return hosts;
}

/** Blocks each unblocked case that names a failed host, with that probe's reason. */
export function blockUnreachable(
  plan: RunPlan,
  cases: readonly LoadedCase[],
  project: Project,
  env: Environment,
  failures: readonly ProbeFailure[],
): void {
  if (failures.length === 0) return;
  plan.cases.forEach((planned, position) => {
    const loaded = cases[position];
    if (planned.blocked !== undefined || loaded === undefined) return;
    const hosts = caseHosts(loaded.spec, project, env, planned.identities);
    const failure = failures.find(({ host }) => hosts.has(host));
    if (failure !== undefined) planned.blocked = failure.reason;
  });
}

/** The hint of the env's probe for the host a ConnectionFailed could not reach. */
export function probeHint(env: Environment, error: unknown): string | undefined {
  if (!(error instanceof ConnectionFailed)) return undefined;
  return env.probes.find((probe) => probe.url.hostname === error.host)?.hint;
}
