import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND } from "../packages/core/src/brand.ts";

const root = path.resolve(import.meta.dirname, "..");
// run evidence and credential state are data, not source, in whichever project folder they sit
const skippedNames = new Set([".git", "node_modules", "dist", "runs", BRAND.stateDir]);
const validName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function main(args: string[]): number {
  const newName = args[0];
  if (newName === undefined || !validName.test(newName)) {
    console.error(
      "usage: pnpm rename <new-name> (lowercase letters and digits, starting with a letter, words joined by single hyphens)",
    );
    return 1;
  }
  renameTree(root, nameReplacer(BRAND.name, newName));
  console.log(`Renamed ${BRAND.name} to ${newName}. Run pnpm install to relink the workspace packages.`);
  return 0;
}

// Matches the name as a whole word in any case, with "-" or "_" between its parts,
// so env vars such as FOO_BAR_TOKEN match the name foo-bar.
function nameReplacer(oldName: string, newName: string): (text: string) => string {
  const word = new RegExp(`(?<![a-z0-9])${oldName.replaceAll("-", "[-_]")}(?![a-z0-9])`, "gi");
  return (text) => text.replace(word, (match) => casedLike(match, newName));
}

function casedLike(match: string, name: string): string {
  if (match === match.toUpperCase()) return name.toUpperCase().replaceAll("-", "_");
  if (match.charAt(0) === match.charAt(0).toUpperCase()) return name.charAt(0).toUpperCase() + name.slice(1);
  return name;
}

// Rewrites file contents first, then renames the entry itself, so paths stay valid during the walk.
function renameTree(dir: string, replaceName: (text: string) => string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const current = path.join(dir, entry.name);
    if (skippedNames.has(entry.name)) continue;
    if (entry.isDirectory()) renameTree(current, replaceName);
    else if (entry.isFile()) rewriteFile(current, replaceName);
    const renamed = replaceName(entry.name);
    if (renamed !== entry.name) renameSync(current, path.join(dir, renamed));
  }
}

function rewriteFile(file: string, replaceName: (text: string) => string): void {
  const content = readFileSync(file);
  if (content.includes(0)) return;
  const text = content.toString("utf8");
  const rewritten = replaceName(text);
  if (rewritten !== text) writeFileSync(file, rewritten);
}

process.exitCode = main(process.argv.slice(2));
