import { retireCase } from "@bazam/core/case";
import { ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import { namedCase } from "./promote.ts";

/** Removes the case from its file and records its id in cases/.retired, so the id is never used again. */
export async function retireCommand(ctx: CommandContext): Promise<ExitCode> {
  const { project } = await ctx.load();
  const target = namedCase(ctx, project);
  await retireCase(project.root, target);
  ctx.out.result({ caseId: target.spec.id, retired: true }, `retired ${target.spec.id}\n`);
  return ExitCode.Pass;
}
