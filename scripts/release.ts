import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// runs on the runner's own Node with no install, so it imports node: builtins only

export type Bump = "rc" | "patch" | "minor" | "final";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  rc?: number;
}

export type ReleaseLine = { kind: "main" } | { kind: "release"; major: number; minor: number };

interface TagRef {
  tag: string;
  sha: string;
  onLine: boolean;
}

export interface NextRelease {
  version: Version;
  tag: string;
  target: string;
  prerelease: boolean;
  latest: boolean;
  previousFinal?: string;
}

export interface Commit {
  sha: string;
  subject: string;
}

export class ReleaseRefused extends Error {}

const repoRoot = path.resolve(import.meta.dirname, "..");
const bumps: readonly string[] = ["rc", "patch", "minor", "final"] satisfies Bump[];
const sections = ["Breaking changes", "Features", "Fixes", "Other"];
const number = "(0|[1-9]\\d*)";
const tagPattern = new RegExp(`^v${number}\\.${number}\\.${number}(?:-rc\\.([1-9]\\d*))?$`);
const releaseBranch = new RegExp(`^release/${number}\\.${number}$`);

export function parseTag(tag: string): Version | undefined {
  const match = tagPattern.exec(tag);
  if (match === null) return undefined;
  const [, major = "", minor = "", patch = "", rc] = match;
  const version = { major: Number(major), minor: Number(minor), patch: Number(patch) };
  return rc === undefined ? version : { ...version, rc: Number(rc) };
}

function formatTag({ major, minor, patch, rc }: Version): string {
  return `v${major}.${minor}.${patch}${rc === undefined ? "" : `-rc.${rc}`}`;
}

export function releaseLine(ref: string): ReleaseLine {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  if (branch === "main") return { kind: "main" };
  const match = branch === undefined ? null : releaseBranch.exec(branch);
  if (match === null)
    throw new ReleaseRefused(
      `ref ${ref} is not the branch main or release/<x>.<y>; dispatch the workflow on one of those branches`,
    );
  return { kind: "release", major: Number(match[1]), minor: Number(match[2]) };
}

// a final version sorts above its own candidates
function compare(a: Version, b: Version): number {
  const rank = (version: Version) => version.rc ?? Number.MAX_SAFE_INTEGER;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || rank(a) - rank(b);
}

function highest<T extends { version: Version }>(tags: readonly T[]): T | undefined {
  return tags.reduce<T | undefined>(
    (best, tag) => (best === undefined || compare(tag.version, best.version) > 0 ? tag : best),
    undefined,
  );
}

export function nextVersion(bump: Bump, line: ReleaseLine, tags: readonly TagRef[], head: string): NextRelease {
  const versioned = tags.flatMap((tag) => {
    const version = parseTag(tag.tag);
    return version === undefined ? [] : [{ ...tag, version }];
  });
  const lineTags = versioned.filter(
    ({ onLine, version }) =>
      onLine && (line.kind === "main" || (version.major === line.major && version.minor === line.minor)),
  );
  const base = highest(lineTags.filter(({ version }) => version.rc === undefined));
  if (line.kind === "release" && base === undefined) {
    throw new ReleaseRefused(
      `release/${line.major}.${line.minor} has no final v${line.major}.${line.minor}.<z> tag; branch it from one`,
    );
  }
  const from: Version = base?.version ?? { major: 0, minor: 0, patch: 0 };
  // rc on main only cuts candidates of the next minor, so a patch candidate belongs to its release line
  const candidate = highest(
    lineTags.filter(
      ({ version }) =>
        version.rc !== undefined && compare(version, from) > 0 && (line.kind === "release" || version.patch === 0),
    ),
  );

  let version: Version;
  let target = head;
  if (bump === "minor") {
    if (line.kind === "release")
      throw new ReleaseRefused("a release line takes patch, rc and final; run minor on main");
    version = { major: from.major, minor: from.minor + 1, patch: 0 };
  } else if (bump === "patch") {
    version = { major: from.major, minor: from.minor, patch: from.patch + 1 };
  } else if (bump === "rc") {
    if (candidate !== undefined) version = { ...candidate.version, rc: (candidate.version.rc ?? 0) + 1 };
    else if (line.kind === "main") version = { major: from.major, minor: from.minor + 1, patch: 0, rc: 1 };
    else version = { major: from.major, minor: from.minor, patch: from.patch + 1, rc: 1 };
  } else {
    if (candidate === undefined)
      throw new ReleaseRefused(
        "no release candidate to finalize; run rc to cut one, or minor or patch to release without one",
      );
    const { major, minor, patch } = candidate.version;
    version = { major, minor, patch };
    target = candidate.sha;
  }

  const tag = formatTag(version);
  if (tags.some((existing) => existing.tag === tag)) throw new ReleaseRefused(`tag ${tag} already exists`);
  const prerelease = version.rc !== undefined;
  const newestFinal = highest(versioned.filter((other) => other.version.rc === undefined));
  const latest = !prerelease && (newestFinal === undefined || compare(version, newestFinal.version) > 0);
  return { version, tag, target, prerelease, latest, ...(base === undefined ? {} : { previousFinal: base.tag }) };
}

function sectionOf(subject: string): string {
  const header = /^([a-z]+)(?:\([^()]*\))?(!)?: /.exec(subject);
  if (header?.[2] === "!") return "Breaking changes";
  if (header?.[1] === "feat") return "Features";
  if (header?.[1] === "fix") return "Fixes";
  return "Other";
}

export function releaseNotes(tag: string, commits: readonly Commit[]): string {
  const body = sections.flatMap((section) => {
    const entries = commits
      .filter(({ subject }) => sectionOf(subject) === section)
      .map(({ sha, subject }) => `- ${subject} (${sha.slice(0, 7)})`);
    return entries.length === 0 ? [] : [`### ${section}\n\n${entries.join("\n")}\n`];
  });
  return [`## ${tag}\n`, ...(body.length === 0 ? ["No new commits.\n"] : body)].join("\n");
}

export async function stamp(root: string, version: string): Promise<string[]> {
  if (parseTag(`v${version}`) === undefined) {
    throw new ReleaseRefused(`version ${version} is not <major>.<minor>.<patch> with an optional -rc.<n>`);
  }
  const packagesDir = path.join(root, "packages");
  const manifests = (await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name, "package.json"))
    .sort();
  for (const file of manifests) {
    const manifest = JSON.parse(await readFile(file, "utf8")) as {
      version: string;
      exports?: Record<string, Record<string, string>>;
    };
    manifest.version = version;
    // the tarballs ship dist/ only, so this condition would resolve to missing sources
    for (const entry of Object.values(manifest.exports ?? {})) delete entry.development;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifests;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function lines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function isAncestorOfHead(sha: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { encoding: "utf8" });
  if (result.status === 0 || result.status === 1) return result.status === 0;
  throw new Error(`git merge-base --is-ancestor ${sha} HEAD failed: ${result.stderr}`);
}

async function plan(bump: Bump): Promise<void> {
  const ref = process.env.GITHUB_REF ?? "";
  const line = releaseLine(ref);
  // an annotated tag names a tag object, so take the commit it peels to
  const peeled = "%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)";
  const tags = lines(git("tag", "--list", "v*", `--format=%(refname:strip=2) ${peeled}`)).map((entry) => {
    const [tag = "", sha = ""] = entry.split(" ");
    return { tag, sha, onLine: isAncestorOfHead(sha) };
  });
  const offLine = tags.filter(({ onLine }) => !onLine).map(({ tag }) => tag);
  if (offLine.length > 0) console.log(`tags not on ${ref}, ignored: ${offLine.join(", ")}`);

  const next = nextVersion(bump, line, tags, git("rev-parse", "HEAD"));
  console.log(`${next.tag} on ${next.target} ${git("log", "-1", "--format=%s", next.target)}`);
  const range = next.previousFinal === undefined ? next.target : `${next.previousFinal}..${next.target}`;
  const commits = lines(git("log", "--format=%H%x09%s", range)).map((entry) => {
    const tab = entry.indexOf("\t");
    return { sha: entry.slice(0, tab), subject: entry.slice(tab + 1) };
  });
  await writeFile("release-notes.md", releaseNotes(next.tag, commits));

  const outputs = [
    `version=${next.tag.slice(1)}`,
    `tag=${next.tag}`,
    `target=${next.target}`,
    `prerelease=${next.prerelease}`,
    `latest=${next.latest}`,
  ].join("\n");
  console.log(outputs);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile !== undefined) await appendFile(outputFile, `${outputs}\n`);
}

function isBump(value: string | undefined): value is Bump {
  return value !== undefined && bumps.includes(value);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "plan" && args.length === 2 && args[0] === "--bump" && isBump(args[1])) {
      await plan(args[1]);
      return 0;
    }
    if (command === "stamp" && args.length === 1 && args[0] !== undefined) {
      for (const file of await stamp(repoRoot, args[0])) console.log(`stamped ${path.relative(repoRoot, file)}`);
      return 0;
    }
  } catch (error) {
    if (!(error instanceof ReleaseRefused)) throw error;
    console.error(error.message);
    return 1;
  }
  console.error("usage: node scripts/release.ts plan --bump rc|patch|minor|final");
  console.error("       node scripts/release.ts stamp <version>");
  return 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
