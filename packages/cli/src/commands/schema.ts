import { buildCaseSchema, caseJsonSchema } from "@bazam/core/case";
import { ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";

/** Prints the JSON Schema of a case file, with the step kinds the project's plugins add. */
export async function schemaCommand(ctx: CommandContext): Promise<ExitCode> {
  const { registry } = await ctx.loadPlugins();
  const schema = caseJsonSchema(buildCaseSchema(registry.stepHandlers()));
  // the schema holds no run data, and the digit rule would turn its integer bounds into text
  ctx.out.result(schema, `${JSON.stringify(schema, null, 2)}\n`, "registered");
  return ExitCode.Pass;
}
