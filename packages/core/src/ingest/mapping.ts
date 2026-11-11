import { z } from "zod";
import { CASE_ID, type CaseSpec } from "../case/index.ts";
import type { ExternalTest } from "./format.ts";

/** A runner's mapping file: test title, without the project prefix, to case id. */
export const MappingFile = z.strictObject({
  tests: z.record(z.string().min(1), z.string().min(1)),
});

const BRACKETED_ID = new RegExp(`\\[(${CASE_ID.source.slice(1, -1)})\\]`);

/** `[<project>] ` then the title joined with ` › `; no prefix without a project. */
export function testTitle(test: ExternalTest): string {
  const title = test.title.join(" › ");
  return test.project ? `[${test.project}] ${title}` : title;
}

export interface UnmappedTest {
  target: string;
  title: string;
  reason: string;
}

export interface MappedTests {
  /** Selected cases only, in report order. */
  byCase: ReadonlyMap<string, ExternalTest[]>;
  unmapped: UnmappedTest[];
  /** Tests of existing cases this run did not select. */
  outsideSelection: number;
}

export interface MappingInputs {
  target: string;
  tests: readonly ExternalTest[];
  /** Every case that loaded, by id. */
  cases: ReadonlyMap<string, CaseSpec>;
  /** The case ids this target runs in this run. */
  selected: ReadonlySet<string>;
  mapping?: { tests: Record<string, string> };
}

/** Places each test under the case it names; a test of a case this run did not select is only counted. */
export function mapTests(inputs: MappingInputs): MappedTests {
  const byCase = new Map<string, ExternalTest[]>();
  const unmapped: UnmappedTest[] = [];
  let outsideSelection = 0;
  for (const test of inputs.tests) {
    const unplaced = (reason: string) =>
      unmapped.push({ target: inputs.target, title: testTitle(test), reason });
    const id = caseIdOf(test, inputs.mapping);
    const spec = id === undefined ? undefined : inputs.cases.get(id);
    if (id === undefined) unplaced("no case id in the test name, its tags or the mapping file");
    else if (spec === undefined) unplaced(`no case ${id}`);
    else if (!spec.targets.includes(inputs.target))
      unplaced(`case ${id} does not run on target ${inputs.target}`);
    else if (!inputs.selected.has(id)) outsideSelection++;
    else {
      const tests = byCase.get(id) ?? [];
      tests.push(test);
      byCase.set(id, tests);
    }
  }
  return { byCase, unmapped, outsideSelection };
}

function caseIdOf(test: ExternalTest, mapping: MappingInputs["mapping"]): string | undefined {
  for (const segment of test.title.toReversed()) {
    const match = BRACKETED_ID.exec(segment);
    if (match !== null) return match[1];
  }
  const tagged = test.tags.map((tag) => tag.replace(/^@/, "")).find((tag) => CASE_ID.test(tag));
  if (tagged !== undefined) return tagged;
  const key = test.title.join(" › ");
  // an own key only, so a title such as "constructor" never reads the object's prototype
  return mapping !== undefined && Object.hasOwn(mapping.tests, key)
    ? mapping.tests[key]
    : undefined;
}
