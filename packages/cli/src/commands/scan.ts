import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadScanValues, scanFiles, type ScanFinding } from "@bazam/core/scan";
import { CommandError, ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";
import { plural } from "../io.ts";
import { runDirOf } from "./plan.ts";
import { readResults } from "./report.ts";

const SHOWN_CONTEXTS = 3;

/**
 * Looks through the run's files for fixture, secret and credential values and for emails and digit runs that
 * should not be there. Exits 1 with any finding, 0 with none.
 */
export async function scanCommand(ctx: CommandContext): Promise<ExitCode> {
  const { flags } = ctx;
  if (flags.run === undefined) throw new CommandError("--run is required: name the run to scan");
  const { project, registry } = await ctx.load();
  const runDir = runDirOf(project.root, flags.run);
  const [first] = await readResults(runDir);
  if (first === undefined) throw new CommandError(`run ${flags.run} has no case results`);
  const env = project.config.envs[first.env];
  if (env === undefined)
    throw new CommandError(
      `run ${flags.run} ran in env "${first.env}", which the config no longer has`,
    );
  const files = await filesUnder(runDir);
  const values = await loadScanValues({
    project,
    registry,
    env,
    redactor: ctx.redactor,
    around: new Date(first.startedAt),
  });
  const report = await scanFiles(runDir, files, values);
  const text = [
    ...groups(report.findings).map(([file, kind, found]) => {
      const contexts = found.slice(0, SHOWN_CONTEXTS).map((finding) => `"${finding.context}"`);
      return `${file}: ${kind} x${found.length}: ${contexts.join(", ")}`;
    }),
    `${plural(report.files, "file")}, ${plural(report.findings.length, "finding")}`,
    ...report.skipped.map((entry) => `skipped ${entry}`),
  ];
  ctx.out.result(report, text.map((line) => `${line}\n`).join(""));
  return report.findings.length === 0 ? ExitCode.Pass : ExitCode.Fail;
}

/** The findings grouped by file and kind, in the order they were found. */
function groups(findings: readonly ScanFinding[]): [string, string, ScanFinding[]][] {
  const byKey = new Map<string, [string, string, ScanFinding[]]>();
  for (const finding of findings) {
    const key = `${finding.file}\0${finding.kind}`;
    const group = byKey.get(key) ?? [finding.file, finding.kind, []];
    group[2].push(finding);
    byKey.set(key, group);
  }
  return [...byKey.values()];
}

async function filesUnder(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(runDir, join(entry.parentPath, entry.name)))
    .toSorted();
}
