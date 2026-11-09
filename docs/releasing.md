# Releasing

The Release workflow (`.github/workflows/release.yml`) creates each release as a Git tag and a GitHub Release with the package tarballs attached. Versions live only in tags. The workflow writes the version into the package manifests inside its own workspace and commits nothing, so `main` keeps `0.0.0` in every `package.json`.

**Starting a release**

1. Dispatch the workflow on the branch of the line you release and pick a bump:

   ```sh
   gh workflow run release.yml -f bump=minor                     # first release: v0.1.0 from main
   gh workflow run release.yml -f bump=rc                        # v0.2.0-rc.1 from main (after v0.1.0)
   gh workflow run release.yml -f bump=rc                        # v0.2.0-rc.2
   gh workflow run release.yml -f bump=final                     # v0.2.0 on the commit of v0.2.0-rc.2
   gh workflow run release.yml --ref release/0.2 -f bump=patch   # v0.2.1 on an old line
   gh workflow run release.yml -f bump=rc -f dry-run=true        # prints the version and the notes, creates nothing
   ```

2. The workflow refuses any ref other than the branches `main` and `release/<x>.<y>`, so a tag is refused even when it has the same name.
3. With `dry-run=true` the workflow plans, runs CI and packs, then stops before it creates the tag. The summary of the `plan` job shows the version and the release notes.

**What each bump does**

1. The workflow reads the `v<major>.<minor>.<patch>` and `v<major>.<minor>.<patch>-rc.<n>` tags whose commits are on the dispatched branch. The highest final release among them is the base, or `0.0.0` on `main` when there is none. On a `release/<x>.<y>` branch only the tags of version `<x>.<y>` count, and the branch needs a final `v<x>.<y>.<z>` tag of its own.
2. `minor` releases the next minor version after the base on the head of the branch. A release line refuses it.
3. `patch` releases the next patch version after the base on the head of the branch.
4. `rc` cuts a release candidate on the head of the branch and marks it as a pre-release. When a candidate above the base is open, it takes the candidate's next number; otherwise it starts `-rc.1` of the next minor version on `main`, or of the next patch version on a release line.
5. `final` releases the open candidate's version on the candidate's own commit, so the final release ships the commit that was tested. With no open candidate it is refused.
6. A version whose tag already exists is refused.
7. A final release below the highest final release in the repository, such as a patch on an old line, is not marked as the latest release.
8. Before 1.0, a breaking change goes in a minor release.

**From v0.1.0 to v0.2.1**

1. `minor` on `main` releases `v0.1.0`, the first release.
2. `rc` on `main` cuts `v0.2.0-rc.1` for testing. A fix lands on `main`, and a second `rc` cuts `v0.2.0-rc.2`.
3. `final` on `main` releases `v0.2.0` on the commit of `v0.2.0-rc.2`, even when `main` has moved on since.
4. A bug turns up in `v0.2.0` while `main` already holds work for 0.3. A `release/0.2` branch from the `v0.2.0` tag takes the fix, and `patch` on that branch releases `v0.2.1`.

**Release lines**

1. Cut a `release/<x>.<y>` branch only to patch an old line. The workflow refuses a `release/<x>.<y>` branch that holds no final `v<x>.<y>.<z>` tag. Branch from the final tag, cherry-pick the fix, push the branch and dispatch `patch` on it:

   ```sh
   git switch -c release/0.2 v0.2.0
   git cherry-pick <fix>
   git push origin release/0.2
   gh workflow run release.yml --ref release/0.2 -f bump=patch
   ```

2. `rc` and then `final` on the same branch work as on `main`, with candidates of the next patch version.
3. Without an old line to patch, release from `main`.

**Release notes**

1. The notes list the commit subjects from the previous final release on the line up to the released commit, or every commit for the first release. Each line reads `- <subject> (<short sha>)`.
2. The subjects fall under Breaking changes (a `!` before the colon), Features (`feat`), Fixes (`fix`) and Other (every other type, and subjects that do not follow Conventional Commits). Empty sections are left out.
3. A release candidate lists everything since the last final release too, so the notes of `rc.2` include the commits of `rc.1`.

**What the workflow runs**

1. `plan` computes the version and the target commit, writes the notes, shows them in the run summary and uploads them.
2. `ci` runs `ci.yml` on the target commit: the checks, unit tests, demo app tests, acceptance runs and secret scan. Called this way, `ci.yml` restores the cached Playwright browsers and saves no cache.
3. `pack` checks out the target, builds it, stamps the version into the six manifests under `packages/` and packs one tarball per package. It holds a read-only token.
4. `publish` runs in the `release` environment and is the only job that can write to the repository. It creates the tag through the GitHub API, then the GitHub Release with the notes and the tarballs. A dry run skips it.
5. A `final` runs the `ci.yml` of the dispatched branch against the candidate's commit. If CI fails because `ci.yml` changed since the candidate, run `rc` for a new candidate, then `final`.

**Installing a release**

1. The tarballs depend on each other at exact versions that are not on npm, so install them together in an empty folder:

   ```sh
   gh release download v0.1.0 --repo 0x67/bazam --pattern '*.tgz'
   npm install ./*.tgz
   ./node_modules/.bin/bazam --help
   ```

2. npm takes the `@bazam/*` packages from the sibling tarballs and the third-party dependencies, such as zod, yaml and `@modelcontextprotocol/sdk`, from the registry.
3. The MCP server of a release reports the release's version to its clients. A build from source reports `0.0.0`.

**Repository setup**

1. Create a `release` environment whose deployment branches (branch rules, not tag rules) are `main` and `release/*`. The `publish` job runs in it.
2. Protect `main` and `release/*`.
3. Add a repository ruleset on `refs/tags/v*` that blocks updates and deletions, so a release tag never moves.

**When a release fails**

1. When CI fails on the target, the `pack` and `publish` jobs do not run and nothing is created.
2. When the tag already exists as `publish` starts, the API answers 422 and the job fails before it creates anything.
3. When `gh release create` fails, gh deletes the draft it uploaded to, but the tag the job created stays. Someone on the bypass list of the tag ruleset deletes it with `gh api -X DELETE repos/{owner}/{repo}/git/refs/tags/<tag>` before a retry.
4. A cancelled `publish` job can leave the tag, with or without a draft release. Delete the draft with `gh release delete <tag> --yes` and the tag as in step 3 before a retry, or the retry plans past the stray tag.

**Publishing to npm**

1. The packages are not on npm yet. Once the name is final, the workflow gains an npm step: `pnpm publish -r --tag next` for a release candidate and `--tag latest` for a final release, with an `NPM_TOKEN` secret or trusted publishing.
