import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse, parseDocument } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { ExitCode } from "../src/exit.ts";
import { cli } from "./support/project.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CASES = join(REPO, "examples", "cases");

let validate: ValidateFunction;
const temps: string[] = [];

beforeAll(async () => {
  // the schema as the example project prints it, so it has the step kinds of the plugins its config loads
  const { code, stdout, stderr } = await cli(["schema", "--root", "examples"], REPO);
  expect(code, stderr).toBe(ExitCode.Pass);
  // the schema lists several types in one `type` keyword, which draft 2020-12 allows
  validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(JSON.parse(stdout));
});

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The schema errors of each YAML file under `dir`, keyed by its path relative to `dir`. */
async function schemaErrors(dir: string): Promise<Map<string, string[]>> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => /\.ya?ml$/.test(file)).sort();
  const errors = new Map<string, string[]>();
  for (const file of files) {
    const valid = validate(parse(await readFile(join(dir, file), "utf8")));
    errors.set(
      file,
      valid
        ? []
        : (validate.errors ?? []).map(
            ({ instancePath, keyword, params }) => `${instancePath} ${keyword} ${JSON.stringify(params)}`,
          ),
    );
  }
  return errors;
}

describe("the example cases", () => {
  it("validate against the JSON Schema the schema command prints", async () => {
    const errors = await schemaErrors(CASES);
    expect(errors.size).toBeGreaterThan(0);
    expect([...errors].filter(([, issues]) => issues.length > 0)).toEqual([]);
  });

  it("fail the schema once a case has a field the schema does not know", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-schema-"));
    temps.push(dir);
    const doc = parseDocument(await readFile(join(CASES, "auth", "email.yaml"), "utf8"));
    doc.setIn(["cases", 0, "owner"], "ops@example.test");
    await writeFile(join(dir, "email.yaml"), doc.toString());
    expect(await schemaErrors(dir)).toEqual(
      new Map([["email.yaml", ['/cases/0 additionalProperties {"additionalProperty":"owner"}']]]),
    );
  });
});
