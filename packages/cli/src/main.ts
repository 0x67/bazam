#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { BRAND } from "@bazam/core/brand";
import { PluginRegistry, type PluginManifest } from "@bazam/core/plugin";
import { loadProject, loadProjectConfig, type Project, type ProjectConfig } from "@bazam/core/project";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";
import driverWeb from "@bazam/driver-web";
import resolvers from "@bazam/resolvers";
import jira from "@bazam/tracker-jira";
import { checkCommand } from "./commands/check.ts";
import { execCommand } from "./commands/exec.ts";
import { ingestCommand } from "./commands/ingest.ts";
import { initCommand } from "./commands/init.ts";
import { keepaliveCommand } from "./commands/keepalive.ts";
import { logoutCommand } from "./commands/logout.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { planCommand } from "./commands/plan.ts";
import { promoteCommand } from "./commands/promote.ts";
import { reportCommand } from "./commands/report.ts";
import { retireCommand } from "./commands/retire.ts";
import { runCommand } from "./commands/run.ts";
import { scanCommand } from "./commands/scan.ts";
import { schemaCommand } from "./commands/schema.ts";
import { CommandError, ExitCode } from "./exit.ts";
import { Output, type CliIo } from "./io.ts";

/** Registered after core and before the plugins the config lists. */
const DEFAULT_PLUGINS: readonly PluginManifest[] = [driverWeb, resolvers, jira];

// one table for every command, so each flag means the same wherever it is given
const OPTIONS = {
  root: { type: "string" },
  env: { type: "string" },
  case: { type: "string", multiple: true },
  domain: { type: "string", multiple: true },
  stage: { type: "string", multiple: true },
  target: { type: "string", multiple: true },
  link: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  suite: { type: "string" },
  seed: { type: "string" },
  channel: { type: "string" },
  json: { type: "boolean" },
  run: { type: "string" },
  "dry-run": { type: "boolean" },
  workers: { type: "string" },
  "from-tracker": { type: "boolean" },
  answers: { type: "string" },
  media: { type: "string" },
  ticket: { type: "string" },
  url: { type: "string" },
  as: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

function parseFlags(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

export type Flags = ReturnType<typeof parseFlags>["values"];

export interface Workspace {
  project: Project;
  registry: PluginRegistry;
}

export interface CommandContext {
  io: CliIo;
  flags: Flags;
  /** The positionals after the command name. */
  args: readonly string[];
  /** --root resolved against `io.cwd`. */
  root: string;
  /**
   * One per invocation; a run registers its secrets here, so stdout and stderr mask them too. Loading the config
   * adds its redaction patterns and screenshot selectors.
   */
  redactor: Redactor;
  out: Output;
  /** The config and the plugins, without the cases; config issues throw a CommandError that lists them. */
  loadPlugins(): Promise<{ config: ProjectConfig; registry: PluginRegistry }>;
  /** The config, then the plugins, then the project. */
  load(): Promise<Workspace>;
}

interface Command {
  usage: string;
  /** An ExitCode, or for exec the exit code of the command it ran. */
  run(ctx: CommandContext): Promise<number>;
}

// one entry per command; usage lists them in this order
const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ["init", { usage: "init", run: initCommand }],
  ["schema", { usage: "schema", run: schemaCommand }],
  ["check", { usage: "check", run: checkCommand }],
  ["plan", { usage: "plan --env <env> [selection] [--as <role>=<identity>]", run: planCommand }],
  [
    "run",
    {
      usage:
        "run --env <env> [selection] [--seed <n>] [--channel terminal|answers-file] [--answers <dir>] [--run <id>] [--workers <n>] [--as <role>=<identity>] [--dry-run]",
      run: runCommand,
    },
  ],
  ["ingest", { usage: "ingest --env <env> --target <target> [selection] [--run <id>] <files...>", run: ingestCommand }],
  [
    "promote",
    { usage: "promote <case-id> --env <env> | promote --from-tracker --env <env> [selection]", run: promoteCommand },
  ],
  ["retire", { usage: "retire <case-id>", run: retireCommand }],
  ["exec", { usage: "exec --env <env> [--channel terminal|answers-file] -- <command> [args]", run: execCommand }],
  ["keepalive", { usage: "keepalive --env <env> --as <identity>", run: keepaliveCommand }],
  ["logout", { usage: "logout [--as <identity>] [--env <env>]", run: logoutCommand }],
  [
    "report",
    {
      usage:
        "report plan --run <id> [--media <file>] | report post --run <id> [--media <file>] [--dry-run] [--json] | report ack <marker> --url <comment-url> [--ticket <tracker>:<key>] [--run <id>]",
      run: reportCommand,
    },
  ],
  ["scan", { usage: "scan --run <id>", run: scanCommand }],
  // run_start spawns this script, from src/ or dist/ as this process runs it
  ["mcp", { usage: "mcp", run: (ctx) => mcpCommand(ctx, fileURLToPath(import.meta.url)) }],
]);

function usage(): string {
  return [
    `Usage: ${BRAND.name} <command> [flags]`,
    "",
    "Commands:",
    ...[...COMMANDS.values()].map((command) => `  ${command.usage}`),
    "",
    "Selection: --case <id> --domain <d> --stage <s> --target <t> --link <tracker>:<key> --tag <t> (each repeatable), --suite <name>",
    "Common: --root <dir> (default: the current directory), --json (one JSON document on stdout, logs on stderr)",
    "",
  ].join("\n");
}

/** The ExitCode of the command, or for exec the exit code of the command it ran. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const redactor = new Redactor(defaultRedactionRules());
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags([...argv]);
  } catch (error) {
    // parseArgs refuses unknown flags and missing values before --json is known, so look for it by hand
    new Output(io, redactor, argv.includes("--json")).error(error);
    return ExitCode.CouldNotStart;
  }
  const { values: flags, positionals } = parsed;
  const out = new Output(io, redactor, flags.json === true);
  const [name, ...args] = positionals;
  if (flags.help === true || name === "help") {
    io.stdout.write(redactor.text(usage()));
    return ExitCode.Pass;
  }
  const command = name === undefined ? undefined : COMMANDS.get(name);
  if (command === undefined) {
    out.error(new CommandError(name === undefined ? "no command given" : `unknown command "${name}"`));
    io.stderr.write(redactor.text(usage()));
    return ExitCode.CouldNotStart;
  }
  const root = resolve(io.cwd, flags.root ?? ".");
  // closed after the command, so no process plugin outlives it
  const registries: PluginRegistry[] = [];
  const loadPlugins = async () => {
    const { config, issues } = await loadProjectConfig(root);
    if (config === undefined) throw new CommandError(`the project config in ${root} does not load`, issues);
    // output written before this point is masked by the default rules only
    redactor.configure(config.redaction);
    const registry = await PluginRegistry.load(config, root, DEFAULT_PLUGINS, {
      log: (line) => out.log(line),
      redactor,
    });
    registries.push(registry);
    return { config, registry };
  };
  const ctx: CommandContext = {
    io,
    flags,
    args,
    root,
    redactor,
    out,
    loadPlugins,
    load: async () => {
      const { registry } = await loadPlugins();
      return { project: await loadProject(root, registry), registry };
    },
  };
  try {
    return await command.run(ctx);
  } catch (error) {
    out.error(error);
    return ExitCode.CouldNotStart;
  } finally {
    await Promise.all(registries.map((registry) => registry.close()));
  }
}

if (import.meta.main) {
  const interrupt = new AbortController();
  const abort = () => interrupt.abort();
  // the first Ctrl-C cancels the run; a second one stops the process as usual
  process.once("SIGINT", abort);
  try {
    process.exitCode = await main(process.argv.slice(2), {
      stdout: process.stdout,
      stderr: process.stderr,
      cwd: process.cwd(),
      signal: interrupt.signal,
    });
  } finally {
    process.off("SIGINT", abort);
  }
}
