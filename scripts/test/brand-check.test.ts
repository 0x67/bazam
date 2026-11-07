import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { BRAND } from "../../packages/core/src/brand.ts";

const root = path.resolve(import.meta.dirname, "../..");

it("reports a scoped package name used as a string but not in import or export specifiers", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "brand-check-test-"));
  onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
  for (const file of ["scripts/brand-check.ts", "packages/core/src/brand.ts"]) {
    cpSync(path.join(root, file), path.join(copy, file));
  }
  const source = path.join("packages", "plugin-x", "src", "index.ts");
  mkdirSync(path.join(copy, path.dirname(source)), { recursive: true });
  writeFileSync(
    path.join(copy, source),
    [
      `import { BRAND } from "${BRAND.scope}/core/brand";`,
      `export { loadCases } from '${BRAND.scope}/core/case';`,
      `const run = await import("${BRAND.scope}/core/run");`,
      `export const plugin = { name: "${BRAND.scope}/resolvers" };`,
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [path.join(copy, "scripts", "brand-check.ts")], { encoding: "utf8" });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe(`${source}:4: export const plugin = { name: "${BRAND.scope}/resolvers" };\n`);
});
