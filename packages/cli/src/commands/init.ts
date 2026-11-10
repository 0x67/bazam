import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BRAND } from "@bazam/core/brand";
import { FIXTURES_FILE, LOCAL_FIXTURES_FILE, STATE_DIRS } from "@bazam/core/project";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";

const GITIGNORE = ".gitignore";
const AGENTS_FILE = "AGENTS.md";
const SECTION_START = `<!-- ${BRAND.markerPrefix}:start -->`;
const SECTION_END = `<!-- ${BRAND.markerPrefix}:end -->`;

/** What init did to each path, relative to the root. */
export interface InitResult {
  created: string[];
  /** Files init added to: missing .gitignore lines, or the marked AGENTS.md section. */
  updated: string[];
  /** Files that existed and that init left as they were. */
  kept: string[];
}

/** Starter files by path; each parses under its schema and passes check. Empty folders get a .gitkeep, so git keeps them. */
const STARTER_FILES: readonly [string, string][] = [
  [
    BRAND.configFile,
    `# Environments the cases run against. A case may open or call only the hosts of its env.
envs:
  local:
    production: false
    hosts: [app.example.test]
    vars:
      APP_URL: https://app.example.test
    # resolvers per challenge kind, tried in order, such as otp-email: [otp-mailpit, human]
    challenges: {}
# where a case runs; driver names the driver, which gets the other settings. A target with
# runner: <name> runs a test suite listed under runners instead, and ${BRAND.name} reads its result files
targets:
  chromium: { driver: playwright, browser: chromium }
# who cases act as, and how each one logs in per surface
identities: {}
`,
  ],
  ["cases/.gitkeep", ""],
  ["flows/.gitkeep", ""],
  [
    "suites.yaml",
    `# Named selections for run --suite <name>; each field narrows the cases as the selection flags do.
regression:
  stages: [regression]
`,
  ],
  [
    "people.yaml",
    `# Tracker account ids by role, for the people a posted comment mentions, such as qa-lead: { jira: <account id> }.
roles: {}
`,
  ],
  [
    FIXTURES_FILE,
    `# Identity fields by fixture name. Copy this file to ${LOCAL_FIXTURES_FILE}, which git ignores,
# and put the real test account values there. Keep reserved addresses such as example.test here.
customer:
  email: customer@example.test
`,
  ],
];

/**
 * Lays out a project in `root` and changes no existing text outside the marked section of AGENTS.md: it writes only
 * the files that are missing, adds the .gitignore lines that are missing, and adds or replaces that section.
 */
export async function initProject(root: string): Promise<InitResult> {
  const result: InitResult = { created: [], updated: [], kept: [] };
  for (const [path, text] of STARTER_FILES) {
    result[(await writeNew(join(root, path), text)) ? "created" : "kept"].push(path);
  }
  result[await ignoreStateFiles(join(root, GITIGNORE))].push(GITIGNORE);
  result[await writeAgentsSection(join(root, AGENTS_FILE))].push(AGENTS_FILE);
  return result;
}

export async function initCommand(ctx: CommandContext): Promise<number> {
  const result = await initProject(ctx.root);
  const lines = [
    ...result.created.map((path) => `created ${path}`),
    ...result.updated.map((path) => `updated ${path}`),
    ...result.kept.map((path) => `kept ${path}`),
    `Next: set the envs in ${BRAND.configFile}, then run ${BRAND.name} check.`,
    "",
  ];
  ctx.out.result(result, lines.join("\n"));
  return ExitCode.Pass;
}

type Change = keyof InitResult;

/** False when the file exists. */
async function writeNew(file: string, text: string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function ignoreStateFiles(file: string): Promise<Change> {
  const wanted = [...STATE_DIRS.map((dir) => `${dir}/`), LOCAL_FIXTURES_FILE];
  const text = await readText(file);
  if (text === undefined) {
    await writeFile(file, `${wanted.join("\n")}\n`, { flag: "wx" });
    return "created";
  }
  // "/runs/" and "runs" ignore the same folder as "runs/"
  const bare = (line: string): string => line.trim().replace(/^\//, "").replace(/\/$/, "");
  const present = new Set(text.split(/\r?\n/).map(bare));
  const missing = wanted.filter((line) => !present.has(bare(line)));
  if (missing.length === 0) return "kept";
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${text}${separator}${missing.join("\n")}\n`);
  return "updated";
}

async function writeAgentsSection(file: string): Promise<Change> {
  const section = agentsSection();
  const text = await readText(file);
  if (text === undefined) {
    await writeFile(file, `${section}\n`, { flag: "wx" });
    return "created";
  }
  const start = text.indexOf(SECTION_START);
  const end = start === -1 ? -1 : text.indexOf(SECTION_END, start);
  if (start === -1 && !text.includes(SECTION_END)) {
    const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(file, `${text}${separator}${section}\n`);
    return "updated";
  }
  // replacing up to some later end marker could swallow text the user wrote
  if (start === -1 || end === -1) {
    throw new CommandError(
      `${AGENTS_FILE} needs ${SECTION_START} followed by ${SECTION_END}, or neither; fix the markers and run ${BRAND.name} init again`,
    );
  }
  const replaced = `${text.slice(0, start)}${section}${text.slice(end + SECTION_END.length)}`;
  if (replaced === text) return "kept";
  await writeFile(file, replaced);
  return "updated";
}

function agentsSection(): string {
  const cli = BRAND.name;
  return [
    SECTION_START,
    `**${cli} test harness**`,
    "",
    `This project's end-to-end cases run with ${cli}. Load the \`${BRAND.skillName}\` skill before you write or change cases, flows, suites or \`${BRAND.configFile}\`.`,
    "",
    "**Commands**",
    "",
    `1. \`${cli} check\` validates the config, cases and flows. Fix every error before a run.`,
    `2. \`${cli} plan --env <env>\` shows what a run would do, without running a step.`,
    `3. \`${cli} run --env <env> [--case <id>]\` runs cases and writes the evidence to \`runs/<run-id>/\`.`,
    `4. \`${cli} exec --env <env> -- <command>\` runs another test command with the challenge service, which answers OTP and other challenges.`,
    `5. \`${cli} ingest --env <env> --target <target> <files...>\` records the result files, such as JUnit XML, of a suite that ran outside ${cli} as a run of the runner target's cases.`,
    `6. \`${cli} keepalive --env <env> --as <identity>\` keeps a logged-in identity's session fresh between runs.`,
    `7. \`${cli} logout --as <identity>\` deletes the identity's cached credentials and revokes them where the strategy can.`,
    `8. \`${cli} report post --run <id>\` posts a run's results to the tracker from CI. An agent posts through the \`report_plan\` MCP tool and the tracker connector instead.`,
    "",
    `Never commit \`runs/\`, \`${BRAND.stateDir}/\` or \`${LOCAL_FIXTURES_FILE}\`: they hold evidence, cached credentials and real test account values.`,
    SECTION_END,
  ].join("\n");
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
