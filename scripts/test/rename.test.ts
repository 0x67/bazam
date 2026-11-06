import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BRAND } from "../../packages/core/src/brand.ts";

const root = path.resolve(import.meta.dirname, "../..");
const notCopied = new Set(["node_modules", "dist", ".git", "runs", BRAND.stateDir]);
const notCopiedAtRoot = new Set(["specs"]);

function copyRepository(): string {
  const copy = mkdtempSync(path.join(tmpdir(), "rename-test-"));
  cpSync(root, copy, {
    recursive: true,
    filter: (source) =>
      !notCopied.has(path.basename(source)) && !notCopiedAtRoot.has(path.relative(root, source)),
  });
  return copy;
}

function pnpm(cwd: string, ...args: string[]): void {
  const result = spawnSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    // without this, pnpm installs the old package names before running the rename script
    env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
    // pnpm is a .cmd shim on Windows, which spawn only runs through a shell
    shell: process.platform === "win32",
  });
  expect(result.status, `pnpm ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
}

function filesMentioning(dir: string, word: RegExp): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => word.test(path.relative(dir, file)) || word.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(dir, file));
}

it("renames a temp copy and builds with brand check passing", () => {
  const copy = copyRepository();
  onTestFinished(() => rmSync(copy, { recursive: true, force: true }));

  pnpm(copy, "rename", "demo-x");
  const oldName = new RegExp(`(?<![a-z0-9])${BRAND.name.replaceAll("-", "[-_]")}(?![a-z0-9])`, "i");
  expect(filesMentioning(copy, oldName)).toEqual([]);

  // The rename rewrites the lockfile too, so a frozen install from the local store works.
  // The repository's own install already ran the supply-chain check on these entries.
  pnpm(copy, "install", "--offline", "--frozen-lockfile", "--trust-lockfile");
  pnpm(copy, "brand:check");
  pnpm(copy, "-r", "build");
}, 300_000);

it("leaves run evidence and state in a nested project folder unchanged", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "rename-test-"));
  onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
  for (const file of ["scripts/rename.ts", "packages/core/src/brand.ts"]) {
    cpSync(path.join(root, file), path.join(copy, file));
  }
  const marker = `${BRAND.markerPrefix}:AUTH-LOGIN-001:20261106-164200-ab12`;
  const files = {
    evidence: path.join("examples", "runs", "20261106-164200-ab12", "post-plan.json"),
    state: path.join("examples", BRAND.stateDir, "receipts.json"),
    doc: path.join("examples", "README.md"),
  };
  for (const file of Object.values(files)) {
    mkdirSync(path.join(copy, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(copy, file), marker);
  }

  const result = spawnSync(process.execPath, [path.join(copy, "scripts", "rename.ts"), "demo-x"], { encoding: "utf8" });

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(copy, files.evidence), "utf8")).toBe(marker);
  expect(readFileSync(path.join(copy, files.state), "utf8")).toBe(marker);
  expect(readFileSync(path.join(copy, files.doc), "utf8")).toBe("demo-x:AUTH-LOGIN-001:20261106-164200-ab12");
});
