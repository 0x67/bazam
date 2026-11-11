import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BRAND } from "../packages/core/src/brand.ts";

// imports no installed packages, only node: builtins and brand.ts

const run = promisify(execFile);

export interface Tarball {
  file: string;
  name: string;
  version: string;
}

export interface Recipes {
  npm: { packageJson: string };
  pnpm: { packageJson: string; workspaceYaml: string };
}

export class InstallCheckFailed extends Error {}

const CLI = BRAND.name;
const OVERRIDDEN = ["core", "driver-web", "mcp", "resolvers", "tracker-jira"].map(
  (p) => `${BRAND.scope}/${p}`,
);
const REQUIRED = [CLI, ...OVERRIDDEN];

export function installRecipes(tarballs: readonly Tarball[]): Recipes {
  const files = new Map(
    tarballs.map(({ name, file }) => [name, `file:vendor/${BRAND.name}/${file}`]),
  );
  for (const name of REQUIRED) {
    if (!files.has(name)) throw new InstallCheckFailed(`no tarball for ${name}`);
  }
  const dependencies = Object.fromEntries(REQUIRED.map((name) => [name, files.get(name)]));
  const overrides = OVERRIDDEN.map((name) => `  "${name}": ${files.get(name)}\n`).join("");
  return {
    npm: { packageJson: `${JSON.stringify({ private: true }, null, 2)}\n` },
    pnpm: {
      packageJson: `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
      workspaceYaml: `overrides:\n${overrides}`,
    },
  };
}

async function readTarball(dir: string, file: string): Promise<Tarball> {
  const { stdout } = await run("tar", ["-xOzf", path.join(dir, file), "package/package.json"]);
  const { name, version } = JSON.parse(stdout) as { name: string; version: string };
  return { file, name, version };
}

async function step(recipe: string, name: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InstallCheckFailed(`${recipe}: ${name} failed: ${reason}`);
  }
}

async function resolveCoreRun(cwd: string): Promise<string> {
  const script = `console.log(import.meta.resolve('${BRAND.scope}/core/run'))`;
  const { stdout } = await run("node", ["--input-type=module", "-e", script], { cwd });
  return realpath(fileURLToPath(stdout.trim()));
}

async function checkInstalled(recipe: string, dir: string): Promise<void> {
  await step(recipe, `${CLI} --help`, () =>
    run(path.join(dir, "node_modules/.bin", CLI), ["--help"], { cwd: dir }),
  );
  await step(recipe, `one ${BRAND.scope}/core`, async () => {
    const fromProject = await resolveCoreRun(dir);
    const fromDriver = await resolveCoreRun(
      await realpath(path.join(dir, "node_modules", BRAND.scope, "driver-web")),
    );
    if (fromProject !== fromDriver)
      throw new Error(`the project resolves ${fromProject}, driver-web ${fromDriver}`);
  });
}

async function checkNpm(dir: string, recipes: Recipes, tarballs: readonly string[]): Promise<void> {
  await step("npm", "write package.json", () =>
    writeFile(path.join(dir, "package.json"), recipes.npm.packageJson),
  );
  await step("npm", "npm install", () =>
    run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], { cwd: dir }),
  );
  await checkInstalled("npm", dir);
}

async function checkPnpm(
  dir: string,
  recipes: Recipes,
  tarballs: readonly string[],
): Promise<void> {
  await step("pnpm", "write the recipe", async () => {
    const vendor = path.join(dir, "vendor", BRAND.name);
    await mkdir(vendor, { recursive: true });
    for (const tarball of tarballs)
      await copyFile(tarball, path.join(vendor, path.basename(tarball)));
    await writeFile(path.join(dir, "package.json"), recipes.pnpm.packageJson);
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), recipes.pnpm.workspaceYaml);
  });
  await step("pnpm", "pnpm install", () => run("pnpm", ["install"], { cwd: dir }));
  await checkInstalled("pnpm", dir);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [folder, ...rest] = argv;
  if (folder === undefined || rest.length > 0) {
    console.error("usage: node scripts/install-check.ts <folder of tarballs>");
    return 1;
  }
  const dirs: string[] = [];
  try {
    const dir = path.resolve(folder);
    const names = (await readdir(dir)).filter((file) => file.endsWith(".tgz")).sort();
    const tarballs = await Promise.all(names.map((file) => readTarball(dir, file)));
    const recipes = installRecipes(tarballs);
    const paths = names.map((file) => path.join(dir, file));
    for (const [recipe, check] of [
      ["npm", checkNpm],
      ["pnpm", checkPnpm],
    ] as const) {
      // under the system temp folder, so no pnpm workspace above it takes the install
      const target = await mkdtemp(path.join(tmpdir(), `install-check-${recipe}-`));
      dirs.push(target);
      await check(target, recipes, paths);
      console.log(`${recipe}: ok`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof InstallCheckFailed)) throw error;
    console.error(error.message);
    return 1;
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
