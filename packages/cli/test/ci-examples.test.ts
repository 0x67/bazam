import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CI = join(REPO, "examples", "ci");
const PLAN_SOURCE = readFileSync(join(REPO, "packages", "cli", "src", "commands", "plan.ts"), "utf8");

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  "continue-on-error"?: unknown;
}

interface Job {
  if?: string;
  environment?: unknown;
  permissions?: unknown;
  outputs?: Record<string, unknown>;
  steps?: Step[];
}

interface Workflow {
  on?: unknown;
  permissions?: unknown;
  concurrency?: { group?: unknown };
  jobs: Record<string, Job>;
}

/** Workflow text by file name. */
type Sources = ReadonlyMap<string, string>;

const RUNS = new RegExp(`\\b${BRAND.name} run\\b`);
const POSTS = new RegExp(`\\b${BRAND.name} (report post|promote)\\b`);
const TRACKER_SECRET = /\bJIRA_(EMAIL|API_TOKEN)\b/;
// the body of each `${{ }}`, read up to `}}` so a `}` inside a string literal does not end it
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const SECRETS_CONTEXT = /(?<![\w.-])secrets\b/;
const NAMED_SECRET = /^\s*secrets\.\w+\s*$/;
// the promotion branch `bazam/promote-<date>` names the brand without calling it
const NPM_CODE = new RegExp(`\\b(npm|npx|pnpm|node|node_modules)\\b|\\b${BRAND.name}\\b(?!/)`);
const CASE_PATHS = String.raw`grep -Ev '^cases/.+\.ya?ml$'`;

const EXAMPLES: Sources = new Map(
  readdirSync(CI)
    .filter((file) => file.endsWith(".yml"))
    .sort()
    .map((file) => [file, readFileSync(join(CI, file), "utf8")]),
);

function workflows(sources: Sources): [string, Workflow][] {
  return [...sources].map(([file, text]) => [file, parse(text) as Workflow]);
}

/** The sources with one file's text edited, to show that a check finds the break. */
function broken(file: string, edit: (text: string) => string): Sources {
  const text = EXAMPLES.get(file) ?? "";
  const edited = edit(text);
  expect(edited, `the edit applies to ${file}`).not.toBe(text);
  return new Map([...EXAMPLES, [file, edited]]);
}

function runsBazam(job: Job): boolean {
  return (job.steps ?? []).some(({ run }) => run !== undefined && RUNS.test(run));
}

/**
 * Whether the job's token can write `scope`, or any scope when it is left out. A job without `permissions` gets the
 * workflow's, and with neither the repository default, which may write.
 */
function canWrite(workflow: Workflow, job: Job, scope?: string): boolean {
  const permissions = job.permissions ?? workflow.permissions;
  if (permissions === undefined || permissions === "write-all") return true;
  if (typeof permissions !== "object" || permissions === null) return false;
  return Object.entries(permissions).some(([name, level]) => level === "write" && (scope ?? name) === name);
}

function isTracker(environment: unknown): boolean {
  if (typeof environment === "object" && environment !== null && "name" in environment)
    return environment.name === "tracker";
  return environment === "tracker";
}

interface Found {
  path: (string | number)[];
  text: string;
  key: boolean;
}

/** Every key and string value in `node`, with its path. */
function texts(node: unknown, path: (string | number)[] = []): Found[] {
  if (typeof node === "string") return [{ path, text: node, key: false }];
  if (Array.isArray(node)) return node.flatMap((item: unknown, index) => texts(item, [...path, index]));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => [
    { path: [...path, key], text: key, key: true },
    ...texts(value, [...path, key]),
  ]);
}

/** The job and step when `path` names an entry of a step's `env`. */
function stepEnv(workflow: Workflow, path: Found["path"]): { job: Job; step: Step } | undefined {
  const [jobs, name, steps, index, env] = path;
  if (path.length !== 6 || jobs !== "jobs" || steps !== "steps" || env !== "env" || typeof index !== "number") {
    return undefined;
  }
  const job = workflow.jobs[String(name)];
  const step = job?.steps?.[index];
  return job === undefined || step === undefined ? undefined : { job, step };
}

function forbiddenTriggers(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, { on }]) => {
    const triggers =
      typeof on === "string"
        ? [on]
        : Array.isArray(on)
          ? on.filter((item): item is string => typeof item === "string")
          : Object.keys(on ?? {});
    return triggers
      .filter((trigger) => ["pull_request", "pull_request_target", "workflow_run"].includes(trigger))
      .map((trigger) => `${file}: ${trigger}`);
  });
}

function withoutBranchConcurrency(sources: Sources): string[] {
  return workflows(sources)
    .filter(([, { concurrency }]) => {
      const group = concurrency?.group;
      return typeof group !== "string" || !/\bgithub\.ref\b/.test(group);
    })
    .map(([file]) => file);
}

function jobsRunningBazam(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => runsBazam(job))
      .map(([name]) => `${file} ${name}`),
  );
}

function writableJobsRunningBazam(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => runsBazam(job) && canWrite(workflow, job, "contents"))
      .map(([name]) => `${file} ${name}`),
  );
}

/** The bodies of the `${{ }}` expressions in `text` that read the secrets context. */
function secretReads(text: string): string[] {
  return [...text.matchAll(EXPRESSION)].map(([, body = ""]) => body).filter((body) => SECRETS_CONTEXT.test(body));
}

/**
 * Where a secret or the job token appears outside the place the workflows allow it: the tracker secrets in the `env`
 * of a step that posts or promotes in a `tracker` job, any other secret in a step's `env` in a job that runs tests
 * and cannot write contents, and `github.token` only as the `GH_TOKEN` of a step that calls gh. An expression that
 * reads the secrets context must be one `secrets.NAME` alone, so `toJSON(secrets)`, `secrets['NAME']` and
 * `format('{0}', secrets.NAME)` count as misplaced wherever they sit.
 */
function misplacedSecrets(sources: Sources): string[] {
  const misplaced = workflows(sources).flatMap(([file, workflow]) =>
    texts(workflow).flatMap(({ path, text, key }) => {
      const at = stepEnv(workflow, path);
      const step = at?.step.run ?? "";
      const reads = secretReads(text);
      const named = reads.every((body) => NAMED_SECRET.test(body));
      let allowed = true;
      if (TRACKER_SECRET.test(text)) {
        allowed = named && at !== undefined && POSTS.test(step) && isTracker(at.job.environment);
      } else if (reads.length > 0) {
        allowed =
          named &&
          at !== undefined &&
          !/\bGITHUB_TOKEN\b/.test(text) &&
          runsBazam(at.job) &&
          !canWrite(workflow, at.job, "contents");
      } else if (/\bgithub\.token\b/.test(text)) {
        allowed = at !== undefined && path[5] === "GH_TOKEN" && /\bgh /.test(step);
      }
      if (!key && path.at(-1) === "GH_TOKEN" && text !== "${{ github.token }}") allowed = false;
      return allowed ? [] : [`${file} ${path.join(".")}`];
    }),
  );
  // an env entry's name and value share a path
  return [...new Set(misplaced)];
}

function jobsOpeningPullRequests(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, { steps = [] }]) => steps.some(({ run }) => run?.includes("gh pr create")))
      .map(([name]) => `${file} ${name}`),
  );
}

/** A pull request needs its branch pushed first, and a body from a file keeps tracker text out of the command. */
function pullRequestProblems(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).flatMap(([name, { steps = [] }]) => {
      const script = steps.map(({ run }) => run ?? "").join("\n");
      const create = script.indexOf("gh pr create");
      if (create === -1) return [];
      const push = script.indexOf("git push");
      const line = script.slice(create).split("\n")[0] ?? "";
      const problems: string[] = [];
      if (push === -1) problems.push(`${file} ${name}: gh pr create has no git push before it`);
      else if (push > create) problems.push(`${file} ${name}: gh pr create runs before git push`);
      if (!line.includes("--body-file") || /\s(--body(?![-\w])|-b\b)/.test(line)) {
        problems.push(`${file} ${name}: gh pr create takes its body inline`);
      }
      return problems;
    }),
  );
}

/** Code in a job can read the job's token from the runner's memory, so a job whose token can write runs no npm code. */
function writeTokenProblems(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => canWrite(workflow, job))
      .flatMap(([name, job]) => {
        const at = `${file} jobs.${name}`;
        const steps = (job.steps ?? []).flatMap(({ uses, run }, index) => [
          ...(uses?.startsWith("actions/setup-node@") ? [`${at}.steps.${index}: sets up Node`] : []),
          ...(run !== undefined && NPM_CODE.test(run) ? [`${at}.steps.${index}: runs npm code`] : []),
        ]);
        const secrets = texts(job)
          .filter(({ text }) => secretReads(text).length > 0)
          .map(({ path }) => `${at}.${path.join(".")}: reads a secret`);
        return [...steps, ...new Set(secrets)];
      }),
  );
}

/** The patch comes from a job that runs npm code, so the job that pushes it commits only YAML files under `cases/`. */
function patchProblems(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).flatMap(([name, { steps = [] }]) => {
      const script = steps.map(({ run }) => run ?? "").join("\n");
      if (!script.includes("gh pr create")) return [];
      const apply = script.indexOf("git apply --index");
      const list = script.indexOf("diff --cached --name-only");
      const commit = script.indexOf("git commit");
      if ([apply, list, commit].includes(-1) || apply > list || list > commit) {
        return [`${file} ${name}: does not apply the patch, list its paths and commit in that order`];
      }
      const check = script.slice(script.lastIndexOf("\n", list) + 1, commit);
      const listing = check.split("\n")[0] ?? "";
      const problems: string[] = [];
      if (!listing.includes("--no-renames")) {
        problems.push(`${file} ${name}: lists a renamed path by its new name only`);
      }
      if (!listing.includes("-c core.quotePath=false")) {
        problems.push(`${file} ${name}: lists a non-ASCII path quoted, so the check refuses it`);
      }
      if (!check.includes(CASE_PATHS) || !check.includes("exit 1")) {
        problems.push(`${file} ${name}: commits paths that are not YAML files under cases/`);
      }
      return problems;
    }),
  );
}

/** The run step continues on error, so the evidence upload and the last step must read its outcome. */
function regressionFailureProblems(sources: Sources): string[] {
  const { jobs } = parse(sources.get("regression.yml") ?? "") as Workflow;
  return Object.entries(jobs).flatMap(([name, { steps = [] }]) => {
    const problems: string[] = [];
    if (steps.find(({ id }) => id === "run")?.["continue-on-error"] !== true) {
      problems.push(`${name}: the run step stops the job on a failed case`);
    }
    const uploads = steps.filter(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
    if (uploads.length === 0) problems.push(`${name}: no evidence upload`);
    const conditions = [
      ...uploads.map((step) => ["upload", step.if] as const),
      ["last step", steps.at(-1)?.if] as const,
    ];
    for (const [what, condition = ""] of conditions) {
      if (!condition.includes("steps.run.outcome") || condition.includes("failure()")) {
        problems.push(`${name}: the ${what} runs on "${condition}"`);
      }
    }
    return problems;
  });
}

/** An empty acceptance stage, told apart by the message `plan.ts` throws, skips the upload and the promote job. */
function emptyStageProblems(sources: Sources, plan: string): string[] {
  const { jobs } = parse(sources.get("promote.yml") ?? "") as Workflow;
  const steps = jobs["acceptance"]?.steps ?? [];
  const run = steps.find(({ id }) => id === "run")?.run ?? "";
  const compared = [...run.matchAll(/ = "([^"$]+)"/g)].map((match) => match[1]);
  const problems: string[] = [];
  if (compared.length !== 1 || !plan.includes(`CommandError("${compared[0]}")`)) {
    problems.push(`the run step compares ${JSON.stringify(compared)}, which plan.ts does not throw`);
  }
  if (jobs["acceptance"]?.outputs?.["empty"] !== "${{ steps.run.outputs.empty }}") {
    problems.push("the acceptance job does not output empty");
  }
  const upload = steps.find(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
  if (upload?.if !== "steps.run.outputs.empty != 'true'") problems.push("the upload runs on an empty stage");
  if (jobs["promote"]?.if !== "needs.acceptance.outputs.empty != 'true'") {
    problems.push("the promote job runs on an empty stage");
  }
  return problems;
}

function credentialedCheckouts(sources: Sources): string[] {
  return workflows(sources).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).flatMap(([name, { steps = [] }]) =>
      steps
        .filter((step) => step.uses?.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false)
        .map(() => `${file} ${name}`),
    ),
  );
}

/**
 * A stricter form of the check scripts/test/release.test.ts runs over .github/workflows: a `run:` script holds no
 * expression at all, so commit messages and wrapped forms such as `toJSON(steps.run.outputs)` stay out too.
 */
function expressionsInRun(sources: Sources): string[] {
  const expression = /\$\{\{/;
  return [...sources].flatMap(([file, text]) => {
    const workflow = parse(text) as { jobs: Record<string, { steps?: { run?: string }[] }> };
    return Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter(({ run }) => run !== undefined && expression.test(run)).map(({ run }) => `${file} ${job}: ${run}`),
    );
  });
}

describe("the example CI workflows", () => {
  it("never run on pull_request, pull_request_target or workflow_run", () => {
    expect(forbiddenTriggers(EXAMPLES)).toEqual([]);
    const edited = broken("regression.yml", (text) =>
      text.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request_target:\n"),
    );
    expect(forbiddenTriggers(edited)).toEqual(["regression.yml: pull_request_target"]);
  });

  it("set concurrency per branch", () => {
    expect(withoutBranchConcurrency(EXAMPLES)).toEqual([]);
    const edited = broken("promote.yml", (text) => text.replace("-${{ github.ref }}", ""));
    expect(withoutBranchConcurrency(edited)).toEqual(["promote.yml"]);
  });

  it("give contents: write to no job that runs bazam run", () => {
    expect(jobsRunningBazam(EXAMPLES)).toEqual(["promote.yml acceptance", "regression.yml regression"]);
    expect(writableJobsRunningBazam(EXAMPLES)).toEqual([]);
    const unset = broken("regression.yml", (text) => text.replace("permissions:\n  contents: read\n", ""));
    expect(writableJobsRunningBazam(unset)).toEqual(["regression.yml regression"]);
    const write = broken("promote.yml", (text) =>
      text.replace("    permissions:\n      contents: read\n", "    permissions:\n      contents: write\n"),
    );
    expect(writableJobsRunningBazam(write)).toEqual(["promote.yml acceptance"]);
  });

  it("use secrets only in the env of the steps allowed them", () => {
    expect(misplacedSecrets(EXAMPLES)).toEqual([]);
    const jobLevel = broken("regression.yml", (text) =>
      text.replace("    environment: tracker\n", "    environment: tracker\n    env:\n      JIRA_EMAIL: x\n"),
    );
    expect(misplacedSecrets(jobLevel)).toEqual(["regression.yml jobs.regression.env.JIRA_EMAIL"]);
    const notPosting = broken("regression.yml", (text) => text.replace("bazam report post", "bazam report plan"));
    expect(misplacedSecrets(notPosting)).toEqual([
      "regression.yml jobs.regression.steps.7.env.JIRA_EMAIL",
      "regression.yml jobs.regression.steps.7.env.JIRA_API_TOKEN",
    ]);
    const noEnvironment = broken("regression.yml", (text) => text.replace("    environment: tracker\n", ""));
    expect(misplacedSecrets(noEnvironment)).toEqual([
      "regression.yml jobs.regression.steps.7.env.JIRA_EMAIL",
      "regression.yml jobs.regression.steps.7.env.JIRA_API_TOKEN",
    ]);
    const appSecretInPromote = broken("promote.yml", (text) =>
      text.replace(
        "JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}",
        "JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}\n          X: ${{ secrets.X }}",
      ),
    );
    expect(misplacedSecrets(appSecretInPromote)).toEqual(["promote.yml jobs.promote.steps.4.env.X"]);
    const repositoryToken = broken("promote.yml", (text) =>
      text.replace("GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"),
    );
    expect(misplacedSecrets(repositoryToken)).toEqual(["promote.yml jobs.pull-request.steps.3.env.GH_TOKEN"]);
    const wholeContext = broken("regression.yml", (text) =>
      text.replace(
        "continue-on-error: true\n",
        "continue-on-error: true\n        env:\n          ALL: ${{ toJSON(secrets) }}\n" +
          "          ONE: ${{ format('{0}', secrets.BAZAM_SECRETS_ENV) }}\n",
      ),
    );
    expect(misplacedSecrets(wholeContext)).toEqual([
      "regression.yml jobs.regression.steps.6.env.ALL",
      "regression.yml jobs.regression.steps.6.env.ONE",
    ]);
    const bracket = broken("promote.yml", (text) =>
      text.replace(
        "JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}",
        "JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}\n          X: ${{ secrets['BAZAM_SECRETS_ENV'] }}",
      ),
    );
    expect(misplacedSecrets(bracket)).toEqual(["promote.yml jobs.promote.steps.4.env.X"]);
    const commitStep = broken("promote.yml", (text) =>
      text.replace(
        "- name: Commit the stage changes\n",
        "- name: Commit the stage changes\n        env:\n          DEBUG: ${{ toJSON(secrets) }}\n",
      ),
    );
    expect(misplacedSecrets(commitStep)).toEqual(["promote.yml jobs.pull-request.steps.2.env.DEBUG"]);
  });

  it("push the branch before gh pr create, which takes its body with --body-file", () => {
    expect(jobsOpeningPullRequests(EXAMPLES)).toEqual(["promote.yml pull-request"]);
    expect(pullRequestProblems(EXAMPLES)).toEqual([]);
    const body = '--body-file "$RUNNER_TEMP/promotion/promote-pr.md"';
    const late = broken("promote.yml", (text) =>
      text
        .replace("git push -u origin HEAD\n", "")
        .replace(`${body}\n`, `${body}\n          git push -u origin HEAD\n`),
    );
    expect(pullRequestProblems(late)).toEqual(["promote.yml pull-request: gh pr create runs before git push"]);
    const unpushed = broken("promote.yml", (text) => text.replace("git push -u origin HEAD\n", ""));
    expect(pullRequestProblems(unpushed)).toEqual(["promote.yml pull-request: gh pr create has no git push before it"]);
    const inline = broken("promote.yml", (text) =>
      text.replace(body, '--body "$(cat "$RUNNER_TEMP/promotion/promote-pr.md")"'),
    );
    expect(pullRequestProblems(inline)).toEqual(["promote.yml pull-request: gh pr create takes its body inline"]);
  });

  it("run no npm code, set up no Node and read no secret in a job whose token can write", () => {
    expect(writeTokenProblems(EXAMPLES)).toEqual([]);
    const download = "      - name: Download the patch and the pull request body\n";
    const install = broken("promote.yml", (text) =>
      text.replace(download, `      - run: npm ci --ignore-scripts\n\n${download}`),
    );
    expect(writeTokenProblems(install)).toEqual(["promote.yml jobs.pull-request.steps.1: runs npm code"]);
    const node = broken("promote.yml", (text) =>
      text.replace(
        download,
        `      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1\n\n${download}`,
      ),
    );
    expect(writeTokenProblems(node)).toEqual(["promote.yml jobs.pull-request.steps.1: sets up Node"]);
    for (const call of ["npx tsx x.ts", "pnpm install", "node x.js", "node_modules/.bin/tsx x.ts", "bazam check"]) {
      const calls = broken("promote.yml", (text) => text.replace("git commit -m", `${call}\n          git commit -m`));
      expect(writeTokenProblems(calls), call).toEqual(["promote.yml jobs.pull-request.steps.2: runs npm code"]);
    }
    const secret = broken("promote.yml", (text) =>
      text.replace("GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ${{ github.token }}\n          X: ${{ secrets.X }}"),
    );
    expect(writeTokenProblems(secret)).toEqual(["promote.yml jobs.pull-request.steps.3.env.X: reads a secret"]);
    const pullRequests = broken("promote.yml", (text) =>
      text.replace(
        "      contents: read\n    outputs:\n      changed:",
        "      contents: read\n      pull-requests: write\n    outputs:\n      changed:",
      ),
    );
    expect(writeTokenProblems(pullRequests)).toEqual([
      "promote.yml jobs.promote.steps.1: sets up Node",
      "promote.yml jobs.promote.steps.2: runs npm code",
      "promote.yml jobs.promote.steps.4: runs npm code",
      "promote.yml jobs.promote.steps.4.env.JIRA_EMAIL: reads a secret",
      "promote.yml jobs.promote.steps.4.env.JIRA_API_TOKEN: reads a secret",
    ]);
  });

  it("apply the promotion patch and refuse paths other than YAML files under cases/ before the commit", () => {
    expect(patchProblems(EXAMPLES)).toEqual([]);
    const order = "promote.yml pull-request: does not apply the patch, list its paths and commit in that order";
    const unapplied = broken("promote.yml", (text) => text.replace("git apply --index", "git apply"));
    expect(patchProblems(unapplied)).toEqual([order]);
    const unlisted = broken("promote.yml", (text) =>
      text.replace("git -c core.quotePath=false diff --cached --name-only --no-renames", "git ls-files"),
    );
    expect(patchProblems(unlisted)).toEqual([order]);
    const renames = broken("promote.yml", (text) => text.replace(" --no-renames)", ")"));
    expect(patchProblems(renames)).toEqual(["promote.yml pull-request: lists a renamed path by its new name only"]);
    const quoted = broken("promote.yml", (text) => text.replace("-c core.quotePath=false ", ""));
    expect(patchProblems(quoted)).toEqual([
      "promote.yml pull-request: lists a non-ASCII path quoted, so the check refuses it",
    ]);
    const outside = "promote.yml pull-request: commits paths that are not YAML files under cases/";
    const anyYaml = broken("promote.yml", (text) => text.replace("'^cases/.+", "'"));
    expect(patchProblems(anyYaml)).toEqual([outside]);
    const unstopped = broken("promote.yml", (text) => text.replace("            exit 1\n", ""));
    expect(patchProblems(unstopped)).toEqual([outside]);
  });

  it("read steps.run.outcome, not failure(), after the regression run", () => {
    expect(regressionFailureProblems(EXAMPLES)).toEqual([]);
    const edited = broken("regression.yml", (text) =>
      text
        .replace("if: ${{ steps.run.outcome == 'failure' }}", "if: ${{ failure() }}")
        .replace("continue-on-error: true", "continue-on-error: false"),
    );
    expect(regressionFailureProblems(edited)).toEqual([
      "regression: the run step stops the job on a failed case",
      'regression: the last step runs on "${{ failure() }}"',
    ]);
  });

  it("skip promotion on an empty acceptance stage, told by the message plan.ts throws", () => {
    expect(emptyStageProblems(EXAMPLES, PLAN_SOURCE)).toEqual([]);
    const reworded = PLAN_SOURCE.replace('"no case matches the selection"', '"the selection matches no case"');
    expect(reworded).not.toBe(PLAN_SOURCE);
    expect(emptyStageProblems(EXAMPLES, reworded)).toEqual([
      'the run step compares ["no case matches the selection"], which plan.ts does not throw',
    ]);
    const unguarded = broken("promote.yml", (text) =>
      text.replace("    if: needs.acceptance.outputs.empty != 'true'\n", ""),
    );
    expect(emptyStageProblems(unguarded, PLAN_SOURCE)).toEqual(["the promote job runs on an empty stage"]);
    const uploadInverted = broken("promote.yml", (text) =>
      text.replace("if: steps.run.outputs.empty != 'true'", "if: steps.run.outputs.empty == 'true'"),
    );
    expect(emptyStageProblems(uploadInverted, PLAN_SOURCE)).toEqual(["the upload runs on an empty stage"]);
    const promoteInverted = broken("promote.yml", (text) =>
      text.replace("if: needs.acceptance.outputs.empty != 'true'", "if: needs.acceptance.outputs.empty == 'true'"),
    );
    expect(emptyStageProblems(promoteInverted, PLAN_SOURCE)).toEqual(["the promote job runs on an empty stage"]);
  });

  it("check out without persisting credentials", () => {
    expect(credentialedCheckouts(EXAMPLES)).toEqual([]);
    const edited = broken("promote.yml", (text) =>
      text.replace("persist-credentials: false", "persist-credentials: true"),
    );
    expect(credentialedCheckouts(edited)).toEqual(["promote.yml acceptance"]);
  });

  it("hold no expression in run scripts, so values reach them only through env", () => {
    expect([...EXAMPLES.keys()]).toEqual(expect.arrayContaining(["promote.yml", "regression.yml"]));
    expect(expressionsInRun(EXAMPLES)).toEqual([]);
    const edited = broken("promote.yml", (text) =>
      text.replace('echo "changed=true"', 'echo "${{ steps.run.outputs.empty }}"'),
    );
    expect(expressionsInRun(edited)).toEqual([expect.stringMatching(/^promote\.yml promote: /)]);
    const commitMessage = broken("regression.yml", (text) =>
      text.replace("run: exit 1", 'run: echo "${{ github.event.head_commit.message }}" && exit 1'),
    );
    expect(expressionsInRun(commitMessage)).toEqual([expect.stringMatching(/^regression\.yml regression: /)]);
    const wrapped = broken("promote.yml", (text) =>
      text.replace('echo "changed=true"', 'echo "${{ toJSON(steps.run.outputs) }}"'),
    );
    expect(expressionsInRun(wrapped)).toEqual([expect.stringMatching(/^promote\.yml promote: /)]);
  });
});
