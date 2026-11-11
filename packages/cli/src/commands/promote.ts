import { BRAND } from "@bazam/core/brand";
import {
  promoteCase,
  type CaseSpec,
  type LoadedCase,
  type PromoteDecision,
} from "@bazam/core/case";
import type { Project, ProjectConfig } from "@bazam/core/project";
import {
  ticketRef,
  ticketsReadyForPromotion,
  trackerProject,
  type TicketState,
  type TicketVerdict,
  type TrackerConnection,
} from "@bazam/core/report";
import { resolveSecret } from "@bazam/core/secrets";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext, Workspace } from "../main.ts";
import { known } from "./keepalive.ts";
import { selection } from "./plan.ts";

/**
 * `promote <case-id>` moves an acceptance case to regression when its latest result in the env passed and exits 1
 * when refused; `--from-tracker` promotes every ready case of the selection.
 */
export async function promoteCommand(ctx: CommandContext): Promise<ExitCode> {
  if (ctx.flags["from-tracker"] === true) return promoteFromTracker(ctx);
  const { project } = await ctx.load();
  const target = namedCase(ctx, project);
  const env = envName(ctx, project);
  const decision = await promoteCase(project.root, target, env);
  const text = decision.ok
    ? `promoted ${target.spec.id} to regression`
    : `not promoted: ${decision.reason}`;
  ctx.out.result({ caseId: target.spec.id, ...decision }, `${text}\n`);
  return decision.ok ? ExitCode.Pass : ExitCode.Fail;
}

/**
 * Promotes each selected acceptance case whose linked tickets are all in a status their project's `promoteOn`
 * lists and whose latest result in the env passed. Every other acceptance case stays, with the reason; cases in
 * other stages are skipped. Exits 0 when it ran.
 */
async function promoteFromTracker(ctx: CommandContext): Promise<ExitCode> {
  if (ctx.args.length > 0) {
    throw new CommandError(
      "promote --from-tracker takes selection flags, such as --case <id>, not a case id",
    );
  }
  const workspace = await ctx.load();
  const { project } = workspace;
  const env = envName(ctx, project);
  const read = ticketReader(ctx, workspace);
  const promoted: string[] = [];
  const stayed: { caseId: string; reason: string }[] = [];
  let text = "";
  for (const loaded of selection(workspace, ctx.flags).cases) {
    const { spec } = loaded;
    if (spec.stage !== "acceptance") continue;
    const verdict = await trackerVerdict(spec, project.config, read);
    const decision: PromoteDecision = verdict.ready
      ? await promoteCase(project.root, loaded, env)
      : { ok: false, reason: verdict.reason };
    if (decision.ok) {
      promoted.push(spec.id);
      text += `promoted ${spec.id} to regression\n`;
    } else {
      stayed.push({ caseId: spec.id, reason: decision.reason });
      text += `${spec.id} stays: ${decision.reason}\n`;
    }
  }
  ctx.out.result({ promoted, stayed }, text);
  return ExitCode.Pass;
}

type TicketReader = (tracker: string, key: string) => Promise<TicketState>;

/** Reads a ticket through its tracker's client, connecting once per tracker. */
function ticketReader(ctx: CommandContext, { project, registry }: Workspace): TicketReader {
  const { config } = project;
  const providers = registry.secretProviders(config.secrets.providers);
  const connections = new Map<string, Promise<TrackerConnection>>();
  return async (tracker, key) => {
    let connection = connections.get(tracker);
    if (connection === undefined) {
      // async, so a missing site or client fails each case of the tracker like a failed connect
      connection = (async () => {
        const settings = config.trackers[tracker];
        if (settings?.site === undefined) throw new Error(`trackers.${tracker}.site is not set`);
        return registry.trackerClient(tracker).connect({
          config: settings,
          secret: (name) => resolveSecret(name, providers, ctx.redactor),
          redactor: ctx.redactor,
          signal: ctx.io.signal,
          log: (line) => ctx.out.log(line),
        });
      })();
      connections.set(tracker, connection);
    }
    return (await connection).ticket(key);
  };
}

/**
 * Reads the case's linked tickets in link order, stopping before the first whose tracker is not in `trackers`
 * or whose project is not in `trackers.<tracker>.projects`.
 */
async function trackerVerdict(
  spec: CaseSpec,
  config: ProjectConfig,
  read: TicketReader,
): Promise<TicketVerdict> {
  const states = new Map<string, TicketState>();
  for (const link of spec.links) {
    const { tracker, key } = ticketRef(link);
    const trackerConfig = Object.hasOwn(config.trackers, tracker)
      ? config.trackers[tracker]
      : undefined;
    // ticketsReadyForPromotion names the project that is not listed
    if (trackerConfig === undefined || !Object.hasOwn(trackerConfig.projects, trackerProject(key)))
      break;
    try {
      states.set(link, await read(tracker, key));
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return ticketsReadyForPromotion(spec, states, config);
}

function envName(ctx: CommandContext, project: Project): string {
  const env = ctx.flags.env;
  if (env === undefined) {
    throw new CommandError(
      `--env is required: promote looks at the latest result in that env; envs: ${known(project.config.envs)}`,
    );
  }
  if (project.config.envs[env] === undefined) {
    throw new CommandError(`unknown env "${env}"; envs: ${known(project.config.envs)}`);
  }
  return env;
}

/** The case the first argument names, among the cases that loaded without issues. */
export function namedCase(ctx: CommandContext, project: Project): LoadedCase {
  const [id] = ctx.args;
  if (id === undefined) throw new CommandError("name the case id");
  const found = project.cases.find((loaded) => loaded.spec.id === id);
  if (found === undefined)
    throw new CommandError(
      `no case ${id} loaded; run ${BRAND.name} check to see the cases that do not load`,
    );
  return found;
}
