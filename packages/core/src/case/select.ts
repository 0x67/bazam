import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { LoadedCase } from "./load.ts";
import { Stage, stagePolicy } from "./stage.ts";

/** Each field present narrows the selection; a case matches a field when any of its values matches. */
export interface CaseFilter {
  ids?: string[];
  domains?: string[];
  stages?: Stage[];
  targets?: string[];
  links?: string[];
  tags?: string[];
}

const Values = z.array(z.string().min(1)).min(1).exactOptional();

/** `suites.yaml`: suite names mapped to filters. */
export const SuitesFile = z.record(
  z.string().min(1),
  z.strictObject({
    ids: Values,
    domains: Values,
    stages: z.array(Stage).min(1).exactOptional(),
    targets: Values,
    links: Values,
    tags: Values,
  }),
);

/** Without a stage filter, selection keeps the stages that run. */
export function selectCases(cases: readonly LoadedCase[], filter: CaseFilter): LoadedCase[] {
  return cases.filter(
    ({ spec, domain }) =>
      matches(filter.ids, [spec.id]) &&
      matches(filter.domains, [domain]) &&
      (filter.stages === undefined
        ? stagePolicy(spec.stage).runs
        : filter.stages.includes(spec.stage)) &&
      matches(filter.targets, spec.targets) &&
      matches(filter.links, spec.links) &&
      matches(filter.tags, spec.tags),
  );
}

function matches(wanted: readonly string[] | undefined, values: readonly string[]): boolean {
  return wanted === undefined || values.some((value) => wanted.includes(value));
}

/** Reads `suites.yaml`, a mapping from suite name to filter. A project without the file has no suites. */
export async function loadSuites(root: string): Promise<Map<string, CaseFilter>> {
  let text: string;
  try {
    text = await readFile(join(root, "suites.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  // a file with only comments parses to null
  const parsed = SuitesFile.safeParse(parse(text) ?? {});
  if (!parsed.success)
    throw new Error(
      `suites.yaml does not match the suite schema:\n${z.prettifyError(parsed.error)}`,
    );
  return new Map(Object.entries(parsed.data));
}
