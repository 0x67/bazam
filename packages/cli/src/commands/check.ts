import type { LoadIssue } from "@bazam/core/case";
import { checkProject } from "@bazam/core/check";
import { loadProjectConfig } from "@bazam/core/project";
import { ExitCode } from "../exit.ts";
import { issueText, plural } from "../io.ts";
import type { CommandContext } from "../main.ts";

/** Reports every issue the built-in and plugin rules find; exits 1 when any is an error. */
export async function checkCommand(ctx: CommandContext): Promise<ExitCode> {
  // config issues are findings here, not a reason the command cannot start
  const { config, issues } = await loadProjectConfig(ctx.root);
  if (config === undefined) return report(ctx, issues);
  const { project, registry } = await ctx.load();
  return report(ctx, checkProject(project, registry.checkRules()));
}

function report(ctx: CommandContext, issues: readonly LoadIssue[]): ExitCode {
  const sorted = [...issues].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const errors = sorted.filter((issue) => issue.severity === "error").length;
  const warnings = sorted.length - errors;
  const summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}`;
  ctx.out.result(
    { issues: sorted, errors, warnings },
    [...sorted.map(issueText), summary, ""].join("\n"),
  );
  return errors === 0 ? ExitCode.Pass : ExitCode.Fail;
}
