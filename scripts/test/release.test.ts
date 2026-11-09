import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { nextVersion, releaseLine, releaseNotes, ReleaseRefused, stamp, type ReleaseLine } from "../release.ts";

const root = path.resolve(import.meta.dirname, "../..");
const { parse } = createRequire(path.join(root, "packages", "core", "package.json"))("yaml") as {
  parse: (text: string) => unknown;
};

const HEAD = "head000000000000000000000000000000000000";
const MAIN: ReleaseLine = { kind: "main" };
const RELEASE_0_2: ReleaseLine = { kind: "release", major: 0, minor: 2 };

function tags(...names: string[]): { tag: string; sha: string; onLine: boolean }[] {
  return names.map((name) => ({ tag: name, sha: `sha-${name}`, onLine: true }));
}

function offLine(name: string): { tag: string; sha: string; onLine: boolean } {
  return { tag: name, sha: `sha-${name}`, onLine: false };
}

describe("nextVersion", () => {
  it("makes the first release v0.1.0 on head with no previous final", () => {
    expect(nextVersion("minor", MAIN, [], HEAD)).toEqual({
      version: { major: 0, minor: 1, patch: 0 },
      tag: "v0.1.0",
      target: HEAD,
      prerelease: false,
      latest: true,
    });
  });

  it("counts minor and patch from the highest final on the line", () => {
    const existing = tags("v0.1.0", "v0.1.1", "not-a-version");

    expect(nextVersion("minor", MAIN, existing, HEAD)).toMatchObject({
      tag: "v0.2.0",
      target: HEAD,
      previousFinal: "v0.1.1",
    });
    expect(nextVersion("patch", MAIN, existing, HEAD)).toMatchObject({ tag: "v0.1.2", latest: true });
  });

  it("cuts rc.1 of the next minor on main after a final, as a pre-release that is not latest", () => {
    expect(nextVersion("rc", MAIN, tags("v0.1.0"), HEAD)).toMatchObject({
      tag: "v0.2.0-rc.1",
      target: HEAD,
      prerelease: true,
      latest: false,
      previousFinal: "v0.1.0",
    });
  });

  it("numbers the next rc of an open candidate", () => {
    expect(nextVersion("rc", MAIN, tags("v0.1.0", "v0.2.0-rc.1", "v0.2.0-rc.2"), HEAD).tag).toBe("v0.2.0-rc.3");
  });

  it("finalizes the open candidate on its own commit", () => {
    expect(nextVersion("final", MAIN, tags("v0.1.0", "v0.2.0-rc.1", "v0.2.0-rc.2"), HEAD)).toEqual({
      version: { major: 0, minor: 2, patch: 0 },
      tag: "v0.2.0",
      target: "sha-v0.2.0-rc.2",
      prerelease: false,
      latest: true,
      previousFinal: "v0.1.0",
    });
  });

  it("refuses final with no open candidate", () => {
    const refusal = new ReleaseRefused(
      "no release candidate to finalize; run rc to cut one, or minor or patch to release without one",
    );

    expect(() => nextVersion("final", MAIN, tags("v0.1.0"), HEAD)).toThrow(refusal);
    expect(() => nextVersion("final", MAIN, tags("v0.2.0-rc.1", "v0.2.0"), HEAD)).toThrow(refusal);
  });

  it("refuses minor on a release line", () => {
    expect(() => nextVersion("minor", RELEASE_0_2, tags("v0.2.0"), HEAD)).toThrow(
      new ReleaseRefused("a release line takes patch, rc and final; run minor on main"),
    );
  });

  it("refuses every bump on a release line with no final of its own minor", () => {
    const refusal = new ReleaseRefused("release/0.2 has no final v0.2.<z> tag; branch it from one");

    for (const bump of ["patch", "rc", "final"] as const) {
      expect(() => nextVersion(bump, RELEASE_0_2, tags("v0.1.0", "v0.2.0-rc.1"), HEAD)).toThrow(refusal);
    }
  });

  it("refuses patch on a release line branched from another minor's final", () => {
    expect(() => nextVersion("patch", RELEASE_0_2, tags("v0.1.0"), HEAD)).toThrow(
      new ReleaseRefused("release/0.2 has no final v0.2.<z> tag; branch it from one"),
    );
  });

  it("refuses a version whose tag exists anywhere in the repository", () => {
    expect(() => nextVersion("minor", MAIN, [offLine("v0.1.0")], HEAD)).toThrow(
      new ReleaseRefused("tag v0.1.0 already exists"),
    );
  });

  it("ignores a candidate whose commit is not on the line", () => {
    const existing = [...tags("v0.1.0"), offLine("v0.2.0-rc.3")];

    expect(nextVersion("rc", MAIN, existing, HEAD).tag).toBe("v0.2.0-rc.1");
    expect(() => nextVersion("final", MAIN, existing, HEAD)).toThrow(ReleaseRefused);
  });

  it("marks a final release on an old line as not latest", () => {
    expect(nextVersion("patch", RELEASE_0_2, [...tags("v0.1.0", "v0.2.0"), offLine("v0.3.0")], HEAD)).toMatchObject({
      tag: "v0.2.1",
      target: HEAD,
      prerelease: false,
      latest: false,
      previousFinal: "v0.2.0",
    });
  });

  it("counts only its own major and minor on a release line", () => {
    // release/0.2 branched from main after v0.3.0-rc.1 was cut there
    expect(nextVersion("rc", RELEASE_0_2, tags("v0.2.0", "v0.3.0-rc.1"), HEAD).tag).toBe("v0.2.1-rc.1");
  });

  it("keeps a release line's patch candidate out of main's rc and final", () => {
    // the release line was merged back, so its candidate sits on main's history
    const existing = tags("v0.2.0", "v0.2.1-rc.1");

    expect(nextVersion("rc", MAIN, existing, HEAD)).toMatchObject({ tag: "v0.3.0-rc.1", target: HEAD });
    expect(() => nextVersion("final", MAIN, existing, HEAD)).toThrow(ReleaseRefused);
    expect(nextVersion("final", RELEASE_0_2, existing, HEAD)).toMatchObject({
      tag: "v0.2.1",
      target: "sha-v0.2.1-rc.1",
      latest: true,
    });
  });
});

describe("releaseLine", () => {
  it("reads main and release/<major>.<minor>", () => {
    expect(releaseLine("refs/heads/main")).toEqual(MAIN);
    expect(releaseLine("refs/heads/release/0.12")).toEqual({ kind: "release", major: 0, minor: 12 });
  });

  it("refuses any other ref", () => {
    for (const ref of [
      "refs/tags/main",
      "refs/tags/release/0.2",
      "main",
      "refs/heads/feature/x",
      "refs/heads/release/0.2.1",
      "refs/heads/release/v0.2",
      "refs/heads/release/01.2",
    ]) {
      expect(() => releaseLine(ref)).toThrow(
        new ReleaseRefused(
          `ref ${ref} is not the branch main or release/<x>.<y>; dispatch the workflow on one of those branches`,
        ),
      );
    }
  });
});

describe("releaseNotes", () => {
  it("groups commit headers into sections in a fixed order and leaves empty ones out", () => {
    const commits = [
      { sha: "1111111aaaa", subject: "docs: describe releases" },
      { sha: "2222222bbbb", subject: "feat(cli): add ingest" },
      { sha: "3333333cccc", subject: "feat(core)!: rename the result field" },
      { sha: "4444444dddd", subject: "Update README" },
      { sha: "5555555eeee", subject: "feat: add workers" },
      { sha: "6666666ffff", subject: "fix(driver-web): wait for the page" },
    ];

    expect(releaseNotes("v0.2.0", commits)).toBe(
      [
        "## v0.2.0",
        "",
        "### Breaking changes",
        "",
        "- feat(core)!: rename the result field (3333333)",
        "",
        "### Features",
        "",
        "- feat(cli): add ingest (2222222)",
        "- feat: add workers (5555555)",
        "",
        "### Fixes",
        "",
        "- fix(driver-web): wait for the page (6666666)",
        "",
        "### Other",
        "",
        "- docs: describe releases (1111111)",
        "- Update README (4444444)",
        "",
      ].join("\n"),
    );
    expect(releaseNotes("v0.2.1", [{ sha: "7777777gggg", subject: "fix: handle x" }])).toBe(
      ["## v0.2.1", "", "### Fixes", "", "- fix: handle x (7777777)", ""].join("\n"),
    );
  });
});

describe("stamp", () => {
  function copyManifests(): string {
    const copy = mkdtempSync(path.join(tmpdir(), "release-test-"));
    onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
    const packages = readdirSync(path.join(root, "packages")).map((name) => path.join("packages", name));
    for (const dir of ["", path.join("examples", "demo-app"), ...packages]) {
      cpSync(path.join(root, dir, "package.json"), path.join(copy, dir, "package.json"));
    }
    return copy;
  }

  function read(copy: string, file: string): string {
    return readFileSync(path.join(copy, file), "utf8");
  }

  it("writes the version into each package and drops the development condition, leaving private manifests", async () => {
    const copy = copyManifests();

    const written = await stamp(copy, "0.1.0-rc.1");

    expect(written.map((file) => path.relative(copy, file))).toEqual(
      ["cli", "core", "driver-web", "mcp", "resolvers", "tracker-jira"].map((name) =>
        path.join("packages", name, "package.json"),
      ),
    );
    for (const file of written) {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        version: string;
        exports?: Record<string, Record<string, string>>;
      };
      expect(manifest.version).toBe("0.1.0-rc.1");
      for (const entry of Object.values(manifest.exports ?? {})) expect(Object.keys(entry)).toEqual(["default"]);
    }
    expect(read(copy, "package.json")).toBe(read(root, "package.json"));
    const demo = path.join("examples", "demo-app", "package.json");
    expect(read(copy, demo)).toBe(read(root, demo));
  });

  it("refuses a version outside the tag pattern and writes nothing", async () => {
    const copy = copyManifests();
    const core = path.join("packages", "core", "package.json");

    for (const version of ["0.1", "v0.1.0", "0.1.0-beta.1", "01.0.0", "0.1.0-rc.0", "0.1.0\nfiles=[]"]) {
      await expect(stamp(copy, version)).rejects.toThrow(ReleaseRefused);
    }
    expect(read(copy, core)).toBe(read(root, core));
  });
});

it("passes inputs, job outputs and step outputs to run scripts only through env", () => {
  const dir = path.join(root, ".github", "workflows");
  const files = readdirSync(dir).filter((file) => file.endsWith(".yml"));
  const expression = /\$\{\{\s*(inputs|needs|steps)\./;

  const offending = files.flatMap((file) => {
    const workflow = parse(readFileSync(path.join(dir, file), "utf8")) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    return Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter(({ run }) => run !== undefined && expression.test(run)).map(({ run }) => `${file} ${job}: ${run}`),
    );
  });

  expect(files).toEqual(expect.arrayContaining(["ci.yml", "release.yml"]));
  expect(offending).toEqual([]);
});
