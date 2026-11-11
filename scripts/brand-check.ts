import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BRAND } from "../packages/core/src/brand.ts";

const root = path.resolve(import.meta.dirname, "..");
const brandFile = path.join(root, "packages", "core", "src", "brand.ts");

function main(): number {
  const name = BRAND.name.replaceAll("-", "[-_]");
  const word = new RegExp(`(?<![a-z0-9])${name}(?![a-z0-9])`, "i");
  // an import or export specifier has to spell out the workspace package, and the rename script rewrites it;
  // the same string anywhere else, such as a plugin name, should read from BRAND, so the check reports it
  const importSpecifier = new RegExp(
    `(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])@${name}/[^"']*\\2`,
    "gi",
  );
  let hits = 0;
  for (const file of packageSourceFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!word.test(line.replace(importSpecifier, "$1"))) return;
      console.log(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
      hits++;
    });
  }
  return hits === 0 ? 0 : 1;
}

function packageSourceFiles(): string[] {
  const packagesDir = path.join(root, "packages");
  return readdirSync(packagesDir)
    .map((pkg) => path.join(packagesDir, pkg, "src"))
    .filter((srcDir) => existsSync(srcDir))
    .flatMap((srcDir) => readdirSync(srcDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => file !== brandFile);
}

process.exitCode = main();
