import { isMap, isNode, isScalar, isSeq, visit, type Document, type Node, type YAMLMap } from "yaml";
import { BRAND } from "../brand.ts";
import {
  expandFlows,
  FlowCycle,
  InvalidFlowUse,
  NestedFlowNotOneStep,
  stepKind,
  type ChallengeStep,
  type GuidedStep,
  type LoadedCase,
  type RequestStep,
  type SourceSpan,
  type Step,
} from "../case/index.ts";
import { humanResolver } from "../challenge/index.ts";
import { findPlaceholders, isPhoneForm, phoneForm } from "../env/index.ts";
import {
  externalCaseProblem,
  FIXTURES_FILE,
  lineAt,
  runnerOf,
  STATE_DIRS,
  type Project,
  type ProjectFile,
} from "../project.ts";
import type { CheckIssue, CheckRule } from "./check.ts";

interface Finding {
  at: SourceSpan;
  message: string;
  fix: string;
}

const ALLOW_SECRET = `# ${BRAND.markerPrefix}: allow-secret`;
const SECRET_PATTERNS: readonly { what: string; pattern: RegExp }[] = [
  { what: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: "a GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { what: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { what: "a JWT", pattern: /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/ },
  { what: "a private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
// runs of base64, base64url and hex characters, so URLs and emails split at their punctuation
const SECRET_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
const MIN_SECRET_BITS_PER_CHAR = 4.0;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const RESERVED_EMAIL_DOMAIN = /(?:^|\.)example\.(?:test|com|org|net)$/i;

export const builtinRules: readonly CheckRule[] = [
  loaderRule("schema"),
  loaderRule("id-format"),
  loaderRule("id-domain"),
  loaderRule("id-unique"),
  loaderRule("id-retired"),
  rule("case-has-check", "error", casesWithoutCheck),
  rule("stage-link", "error", casesWithoutLink),
  rule("flow-expands", "error", flowUsesThatFail),
  rule("placeholder-resolves", "error", unresolvedPlaceholders),
  rule("no-literal-secret", "error", literalSecrets),
  rule("fixture-domain", "error", unreservedEmails),
  rule("human-only-chain", "error", automatedHumanOnlyChains),
  rule("prod-safe", "error", writesWithoutFlag),
  rule("state-ignored", "error", stateDirsNotIgnored),
  rule("selector-test-id", "warning", selectorsWithoutTestId),
  rule("external-case-shape", "error", misshapenExternalCases),
  rule("runner-format-known", "error", unknownRunnerFormats),
  withLoaderIssues(rule("runner-mapping-valid", "error", unplacedMappingEntries)),
];

/** The project loader already reports these issues. */
function loaderRule(id: string): CheckRule {
  return { id, check: (project) => project.issues.filter((issue) => issue.ruleId === id) };
}

/** The loader's issues under the rule's id, then the rule's own. */
function withLoaderIssues(own: CheckRule): CheckRule {
  return { id: own.id, check: (project) => [...loaderRule(own.id).check(project), ...own.check(project)] };
}

function rule(id: string, severity: CheckIssue["severity"], find: (project: Project) => Finding[]): CheckRule {
  return {
    id,
    check: (project) =>
      find(project).map(({ at, message, fix }) => ({
        ruleId: id,
        severity,
        file: at.file,
        line: at.line,
        message,
        fix,
      })),
  };
}

/** An external case gets its checks from the runner's tests at run time. */
function casesWithoutCheck(project: Project): Finding[] {
  return project.cases
    .filter(({ spec }) => !spec.targets.some((target) => runnerOf(project.config, target) !== undefined))
    .filter(({ spec }) => spec.checks.length === 0 && !spec.steps.some(isCheckStep))
    .map(({ spec, source }) => ({
      at: source,
      message: `${spec.id} has no check`,
      fix: "Add a checks entry, an expect step, or a guided step with expected.",
    }));
}

function isCheckStep(step: Step): boolean {
  const kind = stepKind(step);
  return kind === "expect" || (kind === "guided" && (step[kind] as GuidedStep).expected !== undefined);
}

function casesWithoutLink(project: Project): Finding[] {
  return project.cases
    .filter(({ spec }) => (spec.stage === "acceptance" || spec.once) && spec.links.length === 0)
    .map(({ spec, source }) => ({
      at: source,
      message: `${spec.id} is ${spec.once ? "a once case" : "an acceptance case"} with no link`,
      fix: "Add the ticket the case covers to links, such as links: [jira:DEMO-246].",
    }));
}

/** The run expands each step on its own the same way, so a case step points at its own problem. */
function flowUsesThatFail(project: Project): Finding[] {
  return project.cases.flatMap((loaded) =>
    (["steps", "checks"] as const).flatMap((list) =>
      loaded.spec[list].flatMap((step, index) => {
        const problem = expansionProblem(step, project);
        if (problem === undefined) return [];
        return [
          { at: spanAt(project, loaded.source.file, ["cases", caseIndex(project, loaded), list, index]), ...problem },
        ];
      }),
    ),
  );
}

function expansionProblem(step: Step, project: Project): Omit<Finding, "at"> | undefined {
  try {
    expandFlows([step], project.flows);
    return undefined;
  } catch (error) {
    if (error instanceof FlowCycle) {
      return { message: error.message, fix: "Remove the use step that leads back to a flow already on this path." };
    }
    if (error instanceof NestedFlowNotOneStep) {
      return {
        message: error.message,
        fix: "Point the trigger or observe at a flow with exactly one step, or write that step in place.",
      };
    }
    if (error instanceof InvalidFlowUse) {
      return {
        message: error.message,
        fix: "Use a flow defined under flows/, and pass in with: exactly the params it declares.",
      };
    }
    throw error;
  }
}

function unresolvedPlaceholders(project: Project): Finding[] {
  const findings: Finding[] = [];
  for (const { file, node } of placeholderScopes(project)) {
    visit(node, {
      Scalar(key, node) {
        if (key === "key" || typeof node.value !== "string") return;
        for (const placeholder of findPlaceholders(node.value)) {
          const problem = placeholderProblem(project, placeholder);
          if (problem !== undefined) findings.push({ at: nodeSpan(file, node), ...problem });
        }
      },
    });
  }
  return findings;
}

/** Case and flow files, and the auth settings under `identities` in the config. */
function placeholderScopes(project: Project): { file: ProjectFile; node: Document | Node }[] {
  const scopes: { file: ProjectFile; node: Document | Node }[] = stepFiles(project).map((file) => ({
    file,
    node: file.doc,
  }));
  const config = project.files.get(BRAND.configFile);
  const identities = config?.doc.get("identities", true);
  if (config !== undefined && isNode(identities)) scopes.push({ file: config, node: identities });
  return scopes;
}

/** Only `env`, `secret` and `identity` can be checked before a run. */
function placeholderProblem(project: Project, placeholder: string): Omit<Finding, "at"> | undefined {
  const { config } = project;
  const [namespace, path] = splitFirst(placeholder.slice("${".length, -"}".length));
  switch (namespace) {
    case "env": {
      const missing = Object.values(config.envs).filter((env) => !Object.hasOwn(env.vars, path));
      if (missing.length === 0) return undefined;
      return {
        message: `${placeholder} is not a var of env ${missing.map((env) => env.name).join(", ")}`,
        fix: `Add ${path} to the vars of each of those envs in ${BRAND.configFile}.`,
      };
    }
    case "secret":
      if (config.secrets.names.includes(path)) return undefined;
      return {
        message: `${placeholder} names a secret that ${BRAND.configFile} does not declare`,
        fix: `Add ${path} to secrets.names in ${BRAND.configFile}.`,
      };
    case "identity":
      return identityProblem(project, placeholder, path);
    default:
      return undefined;
  }
}

/** `path` is `<name>.<field>`, or `<name>.<field>.<form>` for a phone form of the field. */
function identityProblem(project: Project, placeholder: string, path: string): Omit<Finding, "at"> | undefined {
  const [name, field] = splitFirst(path);
  const { identities } = project.config;
  const entry = Object.hasOwn(identities, name) ? identities[name]?.fixture : undefined;
  const fields = entry !== undefined && Object.hasOwn(project.fixtures, entry) ? project.fixtures[entry] : undefined;
  if (fields !== undefined && Object.hasOwn(fields, field)) return undefined;
  const dot = field.lastIndexOf(".");
  const phoneField = field.slice(0, dot);
  const form = field.slice(dot + 1);
  const phone =
    dot !== -1 && fields !== undefined && Object.hasOwn(fields, phoneField) ? fields[phoneField] : undefined;
  if (phone !== undefined && isPhoneForm(form)) {
    // the locale sets only the language of a country name, never whether a form resolves
    if (phoneForm(phone, form, "en") !== undefined) return undefined;
    return {
      message: `${placeholder} does not resolve: ${phoneField} of identity ${name} in ${FIXTURES_FILE} is not a phone number with a ${form} form`,
      fix: `Store ${phoneField} in E.164 form, such as "+447700900123", in ${FIXTURES_FILE}.`,
    };
  }
  return {
    message: `${placeholder} does not resolve: ${FIXTURES_FILE} has no ${field} for identity ${name}`,
    fix: `Give identity ${name} a fixture in ${BRAND.configFile} and add ${field} to that entry in ${FIXTURES_FILE}.`,
  };
}

function literalSecrets(project: Project): Finding[] {
  // mapping keys are test titles and its values are case ids
  const mappings = new Set(Object.values(project.config.runners).flatMap(({ mapping }) => mapping ?? []));
  const files = [...project.files.values()].filter((file) => !mappings.has(file.path));
  return files.flatMap(fileLines).flatMap(({ at, text }) => {
    if (text.includes(ALLOW_SECRET)) return [];
    const secret = secretIn(text);
    if (secret === undefined) return [];
    return [
      {
        at,
        message: `line holds ${secret}`,
        fix: `Move the value to a secret provider and write \${secret.NAME}; end a line that holds no secret with "${ALLOW_SECRET}".`,
      },
    ];
  });
}

/** What kind of secret the line seems to hold, without the value. */
function secretIn(line: string): string | undefined {
  const known = SECRET_PATTERNS.find(({ pattern }) => pattern.test(line));
  if (known !== undefined) return known.what;
  const random = line.match(SECRET_TOKEN)?.find((token) => entropy(token) >= MIN_SECRET_BITS_PER_CHAR);
  if (random === undefined) return undefined;
  return `a ${random.length}-character string with ${entropy(random).toFixed(1)} bits of entropy per character`;
}

/** Shannon entropy in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/** Only the identities fixtures file; a case may well name the app's real support address. */
function unreservedEmails(project: Project): Finding[] {
  const fixtures = project.files.get(FIXTURES_FILE);
  return (fixtures === undefined ? [] : fileLines(fixtures)).flatMap(({ at, text }) =>
    [...text.matchAll(EMAIL)]
      .map((match) => match[1] ?? "")
      .filter((domain) => !RESERVED_EMAIL_DOMAIN.test(domain))
      .map((domain) => ({
        at,
        message: `an email address on ${domain}, which is not a reserved test domain`,
        fix: "Use an address on example.test, example.com, example.org or example.net.",
      })),
  );
}

function automatedHumanOnlyChains(project: Project): Finding[] {
  const findings: Finding[] = [];
  for (const [env, { challenges }] of Object.entries(project.config.envs)) {
    for (const [kind, chain] of Object.entries(challenges)) {
      // a resolver no plugin registered counts as automated, since nothing says a person answers it
      const automated = chain.some((name) => project.resolvers.get(name)?.automated !== false);
      if (!automated || project.challengeKinds.get(kind)?.humanOnly !== true) continue;
      findings.push({
        at: spanAt(project, BRAND.configFile, ["envs", env, "challenges", kind]),
        message: `env ${env} answers human-only challenge ${kind} with ${chain.join(", ")}`,
        fix: `Set ${kind} to [${humanResolver.name}] under the challenges of env ${env}.`,
      });
    }
  }
  return findings;
}

function writesWithoutFlag(project: Project): Finding[] {
  return project.cases
    .filter(({ spec }) => spec.prod_safe)
    .flatMap((loaded) =>
      (["steps", "checks"] as const)
        .flatMap((list) => loaded.spec[list].flatMap((step, index) => requestsIn(step, [list, index])))
        .filter(({ request }) => request.method !== "GET" && request.write !== true)
        .map(({ request, path }) => ({
          at: spanAt(project, loaded.source.file, ["cases", caseIndex(project, loaded), ...path]),
          message: `${loaded.spec.id} is prod_safe but its ${request.method} request does not set write: true`,
          fix: "Add write: true to this request, or remove prod_safe from the case.",
        })),
    );
}

/** The request steps in `step`, also inside a challenge trigger or a guided observe, with their paths. */
function requestsIn(step: Step, path: readonly PropertyKey[]): { request: RequestStep; path: PropertyKey[] }[] {
  const kind = stepKind(step);
  const payload = step[kind];
  if (kind === "request") return [{ request: payload as RequestStep, path: [...path, kind] }];
  if (kind === "challenge") {
    const { trigger } = payload as ChallengeStep;
    return trigger === undefined ? [] : requestsIn(trigger, [...path, kind, "trigger"]);
  }
  if (kind === "guided") {
    const { observe } = payload as GuidedStep;
    return observe === undefined ? [] : requestsIn(observe, [...path, kind, "observe"]);
  }
  return [];
}

function caseIndex(project: Project, loaded: LoadedCase): number {
  const cases = project.files.get(loaded.source.file)?.doc.get("cases");
  return isSeq(cases) ? cases.items.findIndex((item) => isMap(item) && item.get("id") === loaded.spec.id) : -1;
}

function misshapenExternalCases(project: Project): Finding[] {
  return project.cases.flatMap((loaded) => {
    const problem = externalCaseProblem(project.config, loaded.spec);
    if (problem === undefined) return [];
    const fix =
      problem.field === "targets"
        ? "List only runner targets or only driver targets, and split the case in two if it needs both."
        : `Remove the ${problem.field}: an external case gets its checks from the runner's tests.`;
    const at = spanAt(project, loaded.source.file, ["cases", caseIndex(project, loaded), problem.field]);
    return [{ at, message: problem.message, fix }];
  });
}

function unknownRunnerFormats(project: Project): Finding[] {
  return Object.entries(project.config.runners)
    .filter(([, runner]) => !project.resultFormats.has(runner.format))
    .map(([name, runner]) => ({
      at: spanAt(project, BRAND.configFile, ["runners", name, "format"]),
      message: `runner ${name} uses format ${runner.format}, which no plugin registers`,
      fix: "Use junit or playwright-json, or add the plugin that registers this format.",
    }));
}

/** Mapping entries whose case no case file declares, or whose case runs on no target of the runner. */
function unplacedMappingEntries(project: Project): Finding[] {
  const cases = new Map(project.cases.map(({ spec }) => [spec.id, spec]));
  return [...project.mappings].flatMap(([name, mapping]) => {
    const file = project.config.runners[name]?.mapping ?? "";
    const targets = Object.keys(project.config.targets).filter(
      (target) => runnerOf(project.config, target)?.name === name,
    );
    return Object.entries(mapping.tests).flatMap(([title, id]): Finding[] => {
      const spec = cases.get(id);
      const at = spanAt(project, file, ["tests", title]);
      if (spec === undefined) {
        return [
          {
            at,
            message: `test "${title}" maps to ${id}, which no case declares`,
            fix: "Map the test to the id of a case that exists, or add that case.",
          },
        ];
      }
      if (spec.targets.some((target) => targets.includes(target))) return [];
      return [
        {
          at,
          message: `test "${title}" maps to case ${id}, which does not run on a target of runner ${name}`,
          fix: `Add a target of runner ${name} to the case, or map the test to a case that has one.`,
        },
      ];
    });
  });
}

function stateDirsNotIgnored(project: Project): Finding[] {
  return STATE_DIRS.filter((dir) => !project.ignoredStateDirs.has(dir)).map((dir) => ({
    at: { file: ".gitignore", line: 1 },
    message: `.gitignore does not ignore ${dir}/`,
    fix: `Add the line ${dir}/ to .gitignore in the project root.`,
  }));
}

function selectorsWithoutTestId(project: Project): Finding[] {
  const findings: Finding[] = [];
  for (const file of stepFiles(project)) {
    visit(file.doc, {
      // HTTP steps and checks hold bodies, not selectors
      Pair: (_, pair) =>
        isScalar(pair.key) && (pair.key.value === "request" || pair.key.value === "api") ? visit.SKIP : undefined,
      Map(_, map) {
        const selector = textOrCssSelector(map);
        if (selector === undefined) return;
        findings.push({
          at: nodeSpan(file, map),
          message: `selector { ${selector} } uses neither a test id nor a role`,
          fix: "Select by { id: <test id> } or { role: <role>, name: <name> }, and add a test id to the app where it has none.",
        });
      },
    });
  }
  return findings;
}

/** `css: <value>` or `text: <value>` for a map that holds only that selector. */
function textOrCssSelector(map: YAMLMap): string | undefined {
  const [pair] = map.items;
  if (map.items.length !== 1 || pair === undefined || !isScalar(pair.key) || !isScalar(pair.value)) return undefined;
  const { value: key } = pair.key;
  const { value } = pair.value;
  return (key === "css" || key === "text") && typeof value === "string"
    ? `${key}: ${JSON.stringify(value)}`
    : undefined;
}

/** Case and flow files, where steps are written. */
function stepFiles(project: Project): ProjectFile[] {
  return [...project.files.values()].filter((file) => file.path.startsWith("cases/") || file.path.startsWith("flows/"));
}

function fileLines(file: ProjectFile): { at: SourceSpan; text: string }[] {
  return file.text.split(/\r?\n/).map((text, index) => ({ at: { file: file.path, line: index + 1 }, text }));
}

/** Where `path` is in the file, or line 1 of it when the project did not read the file. */
function spanAt(project: Project, file: string, path: readonly PropertyKey[]): SourceSpan {
  const loaded = project.files.get(file);
  return { file, line: loaded === undefined ? 1 : lineAt(loaded, path) };
}

function nodeSpan(file: ProjectFile, node: Node): SourceSpan {
  return { file: file.path, line: file.lines.linePos(node.range?.[0] ?? 0).line };
}

function splitFirst(text: string): [string, string] {
  const dot = text.indexOf(".");
  return dot === -1 ? [text, ""] : [text.slice(0, dot), text.slice(dot + 1)];
}
