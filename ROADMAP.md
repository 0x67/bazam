# Roadmap

As of 2026-11-13, at v0.6.0. The engineering rules behind this plan are in [docs/architecture.md](docs/architecture.md).

**Where bazam stands**

1. bazam is pre-release. Releases v0.1.0 to v0.6.0 came out between 2026-11-08 and 2026-11-13, all of them minor. One adopter, a private UAT suite, runs its cases on it.
2. The code holds up, but the compatibility contract is still weak. v0.6.0 changed `TrackerRenderer.render` and reserved the step kinds `level` and `callout`, yet `PLUGIN_API_VERSION` stayed 1.
3. No commit header in those releases has a `!`, and the release notes don't list a breaking change.
4. Each release makes an adopter rerun its suite. Stability work comes before new features until the first adopter finishes moving its cases.

**Principles**

1. Until the checkpoint below, a release only adds. It never renames or removes a stable config key, case field, CLI flag, result field or plugin type, and never changes such a type's signature.
2. One theme per minor release, at least 14 days apart. Every minor goes out as a release candidate first, adopters run their suites on it, and the final release uses the candidate's commit.
3. Core doesn't take code that only one project needs. Such code goes in the project's own plugins, and mobile drivers, SMS providers and other trackers come as plugins too.
4. Growth waits for numbers. The checkpoint decides whether bazam grows past its first adopter.

**Stage 1. Freeze and fence (now to about 2026-11-20)**

1. No new minor release. A fix goes out as a v0.6.x patch, from a `release/0.6` branch whenever `main` holds unreleased features.
2. The Release workflow refuses `minor` on `main` once a final release exists. It also refuses `patch` on `main` when a `feat` commit was merged after the last release.
3. A stability page in the docs lists the stable surfaces and the deprecation rule from [docs/architecture.md](docs/architecture.md).
4. A compatibility job in CI loads the last release's example cases and config, reads a sample `result.json` from that release, and compares `bazam schema` with the last tag. It and the `install` job become required checks.
5. The v0.6.0 release notes gain their two breaking changes.
6. The npm names `bazam` and `@bazam` are claimed.

**Stage 2. One additive minor, tried as a release candidate**

v0.7.0 changes nothing that an adopter's case files, config or plugins rely on.

1. `PLUGIN_API_VERSION` stays 1, with v0.6.0 as the baseline. A plugin writes the number it was built for as a literal. Core accepts a range from the oldest supported version to the current one and warns before it refuses. From here on, a breaking change to any contribution type raises the version.
2. `result.json` gains a `version` field, and the CLI and the MCP server validate a result when they read it.
3. A process tracker plugin accepts tracker settings it does not know. A new host-side setting then cannot break an older plugin.
4. Config and case loading warn about deprecated fields, and `bazam check` shows the warnings. The first one is the case field `needs`, which nothing reads.
5. An `api` check can poll (`until: { timeoutMs, intervalMs }`), only if an adopter's case waits on a fixed sleep today.
6. Still open: a named lock besides identities. Cases that change one global setting, such as a feature flag on an admin page, would then never run concurrently under `--workers`. Its semantics follow the test locks of Playwright Test 1.65 (`TestDetails.lock`), including an exclusive lock.
7. A per-environment setting turns off or narrows the two built-in masking rules: the part before `@` of an address outside `example.*`, and runs of 8 or more digits. An environment whose customer data is anonymized can then show account numbers and amounts, while registered secrets and fixture values stay masked.
8. `v0.7.0-rc.1` goes out first. Adopters run their suites on it, and `final` releases the same commit.

**Stage 3. The first adopter finishes its move on v0.7.x**

1. Patches only, each one through the compatibility job.
2. Measure the suite. Record a full run of the scripted cases where a person is needed only for the first logins, the minutes a person spends at the keyboard per run, and the run's wall time. Then record the same run with `--workers 2` and a second tester identity.
3. Write a known-limits page and a `SECURITY.md` that cover these limits:
   1. Screenshots are masked only by configured selectors. `bazam scan` skips PNG and JPEG files.
   2. The production write guard covers HTTP steps. Browser steps, in-process plugin HTTP and external suites have no guard.
   3. Evidence stays in your network until you send it somewhere, such as Jira, CI artifacts or the model an agent uses.
   4. Jira Cloud is the only tracker, and API identities cannot use client certificates.
4. Add a deterministic test for the WebKit race at close time, or document the limit.

**Checkpoint, when the first adopter's old harness is gone**

| Check         | Passes when                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Upgrade cost  | On two releases in a row, the adopter changes only the tarballs and the lockfile, not its cases, config or plugins |
| Reliability   | Over three full scripted runs, bazam causes zero blocked cases, and at most 5% of cases end blocked                |
| Attended time | A person is needed only for the first logins of a run                                                              |
| Upkeep        | At most 15 agent runs and 6 hours a month on bazam, two months in a row                                            |
| New value     | 10 more planned scenarios covered in 4 weeks, with at most 20% of new cases needing a bazam change                 |
| Bus factor    | A second person runs the suite from its README                                                                     |

1. When every check passes, the frozen line continues, and a separate decision follows on whether bazam grows past its first adopter (Stage 4).
2. When upgrade cost or reliability fails on two releases in a row, or upkeep runs over for two months, bazam takes fixes only and the adopter keeps the last release.

**Question for the checkpoint: Playwright Test as the runner**

The options are a rewrite of bazam as a Playwright Test library, where cases become TypeScript specs, and an engine that compiles YAML cases into Playwright tests and runs bazam's step loop inside each test, with no change to case files or plugins. A spike decides between them, on a branch after Stage 1, with no release:

1. Compile the example project's cases into Playwright tests and compare their `result.json` files with `bazam run` on the same cases.
2. Check that two cases with the same identity never overlap under Playwright's test locks.
3. Run a case that fills a registered secret and fails, with Playwright's default reporters and tracing, and look for the secret in every output.
4. Start two workers whose cases ask a person at the same moment, through a challenge service started in `globalSetup`. One prompt shows at a time, and no test times out during a 3-minute wait.
5. Force a redirect to the login page in the middle of a case. The compiled engine recovers and reruns one step, while a plain spec can only retry the whole test.
6. Read one value from a native Android screen on a USB phone through playwright-core's experimental `_android` API.

When steps 4 and 5 pass, the rewrite and the engine both become Stage 4 candidates, and the rewrite needs a migration plan that the first adopter accepts. When either fails, the question closes and the current runner stays.

**Stage 4. Growth, one theme per minor (after the checkpoint)**

1. npm releases under the final name. Release tarballs keep working.
2. A JUnit export that puts each test-management tool's ids in the test names, Xray first, once a team needs a test-management UI.
3. A security pack in the release workflow, with an SBOM, provenance and checksums.
4. A version header on the challenge service API, then a Java client.
5. An offline HTML report.
6. A guide for Maestro suites run as external runners, written from a real device run, then the mobile spec with the engine still open.
7. Accessibility checks with axe, a WebDriver driver and a BrowserStack adapter. Their requirements are written and the work is paused.

A breaking change waits for one announced breaking minor. Examples are a case schema that mixes drivers, data-driven cases or a new plugin API version. Deprecation warnings go out one minor ahead, with a migration note.

**Mobile apps, before Stage 4**

A check of a native app starts in the adopter's project, outside core.

1. A `request` step saves the backend value, and a `guided` step asks a person to confirm that the app shows it, with `observe:` running the API check again. This works today with no new code.
2. Before any code, check the device. The app's test build must run with USB debugging on, `uiautomator dump` must show the values, and a machine or a self-hosted runner must hold the phone.
3. Then an in-process plugin step reads the screen over adb, through playwright-core's experimental `_android` API or `uiautomator dump`, or Maestro flows run when the check needs navigation. Appium comes in only if neither works.

**Test management**

bazam is an engine that writes evidence and has no test-management UI of its own. Results go to the Jira ticket, and a project can generate a coverage page from its own catalog of planned scenarios. When a QA lead, an audit, tracked manual runs or several teams need one shared view, adopt a test-management tool (Xray first) and build the JUnit export from Stage 4.

**Parked**

1. The live-vs-replay benchmark (a bench app, 60 cases and a harness) waits on its branch. Its review, its gate and the live and draft arms resume after the checkpoint.
2. Media upload for comments an agent posts waits. Adopters try `bazam report post` first, which has uploaded screenshots and shown them inline since v0.6.0.
3. HTTPS-only environments move to the security pack.

**Not planned**

1. A hosted dashboard or a test-management UI.
2. A built-in model that writes tests.
3. Dependencies between cases, and nested groups in case files.
4. Visual regression.
5. SMS provider resolvers in core.
