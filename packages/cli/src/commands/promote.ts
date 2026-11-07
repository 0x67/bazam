import { promoteCase, type LoadedCase } from "@bazam/core/case";
import type { Project } from "@bazam/core/project";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";

/** Moves an acceptance case to regression when its latest result in the env passed; exits 1 when refused. */
export async function promoteCommand(ctx: CommandContext): Promise<ExitCode> {
  const { project } = await ctx.load();
  const target = namedCase(ctx, project);
  const env = ctx.flags.env;
  if (env === undefined) throw new CommandError("--env is required: promote looks at the latest result in that env");
  if (project.config.envs[env] === undefined) throw new CommandError(`unknown env "${env}"`);
  const decision = await promoteCase(project.root, target, env);
  const text = decision.ok ? `promoted ${target.spec.id} to regression` : `not promoted: ${decision.reason}`;
  ctx.out.result({ caseId: target.spec.id, ...decision }, `${text}\n`);
  return decision.ok ? ExitCode.Pass : ExitCode.Fail;
}

/** The case the first argument names, among the cases that loaded without issues. */
export function namedCase(ctx: CommandContext, project: Project): LoadedCase {
  const [id] = ctx.args;
  if (id === undefined) throw new CommandError("name the case id");
  const found = project.cases.find((loaded) => loaded.spec.id === id);
  if (found === undefined) throw new CommandError(`no case ${id} loaded; check reports cases that do not load`);
  return found;
}
