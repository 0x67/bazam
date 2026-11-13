# Architecture

bazam runs acceptance cases written in YAML, keeps masked evidence for each case, and posts the results to a tracker. `@bazam/core` holds the case model, the run engine and the contracts. Drivers, challenge resolvers, trackers and project code plug into it. This page is for contributors and coding agents who decide where new code goes and what it must not break. Paths are relative to the repository root, and line numbers refer to v0.6.0. Items marked planned come from [ROADMAP.md](../ROADMAP.md) and are not in the code yet.

**Purpose and scope**

1. This page sets the rules for where code goes, how the packages depend on each other, which interfaces adopters rely on, and what every change must keep: masking, environment safety, case status and exit codes.
2. It covers the six packages under `packages/`, the example project in `examples/`, the scripts in `scripts/`, the docs in `docs/` and the CI workflows in `.github/workflows/`.
3. The code and its tests decide what bazam does. When this page and the code disagree, fix one of them in the same pull request.
4. How to use bazam is in the other docs: [configuration.md](configuration.md), [plugins.md](plugins.md), [plugin-protocol.md](plugin-protocol.md), [external-runners.md](external-runners.md), [challenge-service.md](challenge-service.md), [ci-regression.md](ci-regression.md) and [releasing.md](releasing.md).
5. A planned item says so and links [ROADMAP.md](../ROADMAP.md). Until it is merged, the current behavior described next to it holds.

**Layers and package boundaries**

1. bazam has four layers:
   1. Entry points: `bazam` in `packages/cli`, the command line and composition root, and `@bazam/mcp` in `packages/mcp`, an MCP server for agents.
   2. Default plugins: `@bazam/driver-web`, `@bazam/resolvers` and `@bazam/tracker-jira`.
   3. Engine: `@bazam/core`.
   4. Project plugins: the modules and processes a project lists under `plugins:` in its `bazam.config.yaml`.
2. Dependencies point toward core only:

   ```text
   bazam (cli)          -> @bazam/mcp, @bazam/driver-web, @bazam/resolvers, @bazam/tracker-jira, @bazam/core
   @bazam/mcp           -> @bazam/driver-web, @bazam/resolvers, @bazam/tracker-jira, @bazam/core
   @bazam/driver-web    -> @bazam/core
   @bazam/resolvers     -> @bazam/core
   @bazam/tracker-jira  -> @bazam/core
   @bazam/core          -> no @bazam package
   project plugins      -> @bazam/core, and @bazam/driver-web for pageFor
   ```

3. Every `@bazam` dependency is `workspace:*` (`packages/cli/package.json:20-24`, `packages/mcp/package.json:23-26`).
4. The runtime dependencies of `@bazam/core` are `@rgrove/parse-xml`, `fflate`, `libphonenumber-js`, `yaml` and `zod` (`packages/core/package.json:82-88`). Core doesn't import another `@bazam` package, Playwright or an MCP library. A new core dependency needs a reason that holds for every project.
5. `@bazam/driver-web`, `@bazam/resolvers` and `@bazam/tracker-jira` depend on `@bazam/core` alone among workspace packages, and each default-exports a `definePlugin` manifest (`packages/driver-web/src/index.ts:10-15`, `packages/resolvers/src/index.ts:8-13`, `packages/tracker-jira/src/index.ts:6-11`). A plugin package never imports another plugin package.
6. `@bazam/mcp` never imports the CLI. It starts a run by spawning the CLI script by path (`packages/mcp/src/runs.ts:78-99`, `packages/cli/src/main.ts:149`).
7. Outer packages import core by subpath, such as `@bazam/core/case` or `@bazam/core/plugin`, never the package root. A new core area gets its own entry in the `exports` map (`packages/core/package.json:13-78`).
8. Playwright is a peer dependency of driver-web (`packages/driver-web/package.json:27-29`). Core reaches a browser only through the ports `BrowserSession` and `BrowserLogin` (`packages/core/src/auth/browser.ts:5-49`), which driver-web implements.
9. The default plugin list `[driverWeb, resolvers, jira]` is defined twice, in `packages/cli/src/main.ts:36` and `packages/mcp/src/tools.ts:57`. Change both together.
10. Inside core, `run/` orchestrates and may import any other area. No other area imports `run/`, except `plugin/` (item 11). `report/` doesn't import `ingest/`, and `redact/` doesn't import any other core area. Keep new modules on the same side of these lines.
11. These pairs of core areas import each other today. Do not add more:
    1. `case/` and `result/` import each other's types (`packages/core/src/case/stage.ts:5`, `packages/core/src/result/evidence.ts:3`).
    2. `result/` imports a type from `ingest/` (`packages/core/src/result/summary.ts:3`), and `ingest/` imports `EvidenceStore` and types from `result/` (`packages/core/src/ingest/record.ts:5-10`).
    3. `plugin/` imports `CaseBlocked` and `isBlocking` from `run/outcome.ts` (`packages/core/src/plugin/process.ts:11`, `packages/core/src/plugin/serve.ts:16`) and the `PlanCheck` type from `run/plan-checks.ts` (`packages/core/src/plugin/registry.ts:19`).
    4. `plugin/registry.ts` imports `assertHumanOnly` and types from `challenge/`, and `challenge/service.ts` imports the `PluginRegistry` type back (`packages/core/src/plugin/registry.ts:6-11`, `packages/core/src/challenge/service.ts:8`).
    5. `plugin/registry.ts` imports `markdownTracker` and types from `report/`, and `report/direct.ts` imports the `PluginRegistry` type back (`packages/core/src/plugin/registry.ts:18`, `packages/core/src/report/direct.ts:2`).
    6. `auth/identities.ts` imports `guardedHttp` from `driver/http.ts`, and `driver/` imports types from `auth/` (`packages/core/src/auth/identities.ts:4`, `packages/core/src/driver/driver.ts:2`, `packages/core/src/driver/http.ts:3`).
12. `plugin/builtin.ts` imports only types from `plugin/registry.ts`, so the two never form a runtime import cycle (`packages/core/src/plugin/builtin.ts:21,28-29`).

**Where new code goes**

Keep the core small. Ask these questions in order and stop at the first yes.

1. Does only one project need it, such as a step that reads one app's page, a plan check for one team's tags or a sign hook for one API? It goes in that project's own plugins, listed under `plugins:` in its config. `examples/plugins/page-step`, `examples/plugins/plan-check` and `examples/hooks/sign-demo.ts` are examples.
2. Is it written in another language than TypeScript, or must it run in its own process? Write a process plugin ([plugin-protocol.md](plugin-protocol.md)). It can offer only resolvers, challenge kinds, secret providers, result formats, tracker clients and drivers with their steps (`packages/core/src/plugin/proxies.ts:41-66`). `examples/plugins/ts-resolver` and `examples/plugins/python-resolver` show both sides of the protocol.
3. Does it connect bazam to one outside system, such as another tracker, an SMS provider or a mobile device? Write it as a plugin, never in core. Until a second project needs it, keep it in the project that does. A first-party plugin package under `packages/` depends on `@bazam/core` alone, and making it a default plugin means changing both default lists.
4. Does it change what a case means, how a run decides a status, what evidence holds or how values are masked, or does it add a contract that every plugin uses? It goes in core, in the area that owns it (table below). Read the compatibility rules first, since adopters depend on most of these interfaces.
5. Is it about the command line, such as a command, a flag or its output? It goes in `packages/cli`. A flag goes into the shared `OPTIONS` table, so it means the same in every command (`packages/cli/src/main.ts:39-62`). Work the MCP server also needs goes in core.
6. Is it a tool for agents? It goes in `packages/mcp` as a `ToolDefinition` in `caseTools` (`packages/mcp/src/tools.ts:83-88,156`). It calls core, or spawns the CLI for a run.
7. Is it about browsers or Playwright? It goes in `packages/driver-web`.

| Core area                                | Owns                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `case/`                                  | Case schema, loading and id rules, flows, stages, selection, roles                                                      |
| `env/`                                   | Environments, host allowlist, production guards, placeholders, run values                                               |
| `run/`                                   | Planning, env probes, preflight logins, plan checks, scheduling, case runs, outcomes, finishing a run, external runners |
| `result/`                                | Statuses, the evidence store, run summary and progress files                                                            |
| `report/`                                | Post plans, receipts, comment rendering, bug filing, tracker client interfaces                                          |
| `ingest/`                                | External result formats and mapping tests to cases                                                                      |
| `plugin/`                                | Manifest, registry, process plugins and their protocol                                                                  |
| `driver/`                                | `Driver` and `StepHandler` ports, guarded HTTP, the `request` step and `api` check                                      |
| `auth/`                                  | Auth strategies, identities, credential cache, refresh lock, browser ports                                              |
| `challenge/`                             | Challenge kinds, resolver chains, human channels, the challenge service                                                 |
| `secrets/`, `redact/`, `scan/`, `check/` | Secret providers, masking, the post-run scan, check rules                                                               |

**Extension points and their contracts**

Every extension registers with core through one `PluginManifest` (`packages/core/src/plugin/registry.ts:41-57`). `PluginRegistry.load` adds the core plugin, then the default plugins, then each `plugins:` entry in config order (`packages/core/src/plugin/registry.ts:144-180`).

| Manifest field    | Contract                                                                                             | Provided by                                                                                                   | Process plugin             |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `drivers`         | `Driver` (`packages/core/src/driver/driver.ts:65-74`)                                                | driver-web: `playwright`                                                                                      | Yes, with its steps nested |
| `steps`           | `StepHandler` (`packages/core/src/driver/driver.ts:32-38`)                                           | core: `request`, `api`                                                                                        | No, only inside a driver   |
| `authStrategies`  | `AuthStrategy` (`packages/core/src/auth/strategy.ts:46-70`)                                          | core: `api-key`, `basic`, `oauth2`, `session-cookie`, `hmac`                                                  | No                         |
| `resolvers`       | `ChallengeResolver` (`packages/core/src/challenge/resolver.ts:33-49`)                                | core: `human`; driver-web: `passkey-virtual`; resolvers: `totp`, `otp-mailpit`, `otp-http-hook`, `pin-secret` | Yes                        |
| `challengeKinds`  | `ChallengeKindSpec` (`packages/core/src/challenge/kinds.ts:1-9`)                                     | core: `otp-email`, `otp-sms`, `totp`, `passkey`, `pin`, `face`, `biometric`                                   | Yes                        |
| `secretProviders` | `SecretProvider` (`packages/core/src/secrets/provider.ts:3-6`)                                       | core: `env`, `dotenv`, `1password`                                                                            | Yes                        |
| `channels`        | `{ name, create(runDir) }` returning a `HumanChannel` (`packages/core/src/challenge/human.ts:30-32`) | core: `terminal`, `answers-file`                                                                              | No                         |
| `trackers`        | `TrackerRenderer` (`packages/core/src/report/post-plan.ts:70-73`)                                    | tracker-jira: `jira`                                                                                          | No                         |
| `trackerClients`  | `TrackerClient` (`packages/core/src/report/client.ts:78-81`)                                         | tracker-jira: `jira`                                                                                          | Yes                        |
| `checkRules`      | `CheckRule` (`packages/core/src/check/check.ts:14-17`)                                               | core: 20 rules (`packages/core/src/check/rules.ts:62-83`); resolvers: `pin-secret-declared`                   | No                         |
| `resultFormats`   | `ResultFormat` (`packages/core/src/ingest/format.ts:29-32`)                                          | core: `junit`, `playwright-json`                                                                              | Yes                        |
| `planChecks`      | `PlanCheck` (`packages/core/src/run/plan-checks.ts:28-32`)                                           | none                                                                                                          | No                         |

1. A name is unique within its type. A second contribution with the same name throws `PluginConflict`, and there is no override or priority (`packages/core/src/plugin/registry.ts:298-313`). Tracker renderers and tracker clients are keyed by `tracker`, check rules by `id`, and every other type by `name` (`packages/core/src/plugin/registry.ts:100-112`).
2. Core reserves the step kinds `use`, `request`, `challenge`, `guided`, `note`, `followup`, `level`, `callout` and `api` (`packages/core/src/plugin/registry.ts:28-38`). A new core kind goes into `CORE_STEP_KINDS`, and it breaks any plugin that already offers that kind. Different drivers may share a kind such as `open`, but a kind that a driver offers cannot also come from a plugin step (`packages/core/src/plugin/registry.ts:315-329`).
3. Each driver has a `name` that `targets.<t>.driver` refers to, a `surface` its sessions authorize, `probe`, which reports capabilities before any case runs, `launch`, which returns one `DriverSession` per case, and `steps` (`packages/core/src/driver/driver.ts:65-74`). The session's `close(CaseEnding)` ends the case. Every navigation must pass the env's host check (see Environment safety).
4. A step handler gets its payload with placeholders unfilled and calls `ctx.resolve` before it reads a field ([plugins.md](plugins.md), `docs/plugins.md:10`). At run time the case's driver handles a kind first, and a core or plugin step handles it only when the driver has no handler for it (`packages/core/src/plugin/registry.ts:252-259`). A step records evidence through `ctx.evidence`.
5. A resolver declares `kinds`, `requires` and `automated`, with an optional `arm` and a `resolve` (`packages/core/src/challenge/resolver.ts:33-49`). The env's `challenges` map names the chain per kind. A human-only kind never gets a value from any resolver, channel or the challenge service (`packages/core/src/challenge/policy.ts:19-26`). After the trigger, only a non-automated resolver may take over, and only when the kind's `fallbackAfterTrigger` is true (`packages/core/src/challenge/resolver.ts:108-115`).
6. A tracker plugin offers a `TrackerRenderer` for comments and a `TrackerClient` whose `connect` returns a `TrackerConnection` with `ticket`, `attach`, an optional `showUploads`, `postComment`, `editComment`, `transition`, `findOpenBug` and `createBug` (`packages/core/src/report/client.ts:44-66,78-81`). A tracker with no renderer gets a markdown one (`packages/core/src/plugin/registry.ts:234-237`).
7. The process protocol is JSON-RPC 2.0 over newline-delimited stdin and stdout, at most 64 MiB per line (`packages/core/src/plugin/rpc.ts:1-60`):
   1. The host sends `initialize` with `protocolVersion` and `apiVersion` and checks the protocol version before it reads the rest of the answer (`packages/core/src/plugin/process.ts:211-234`).
   2. A `host.*` callback works only inside the call context that offers it. Any other use gets `-32602` (`packages/core/src/plugin/process.ts:284-362`).
   3. The error codes are the JSON-RPC codes `-32600`, `-32601`, `-32602` and `-32603`, plus `-32001` (the case is blocked), `-32002` (cancelled) and `-32003` (line too long) (`packages/core/src/plugin/rpc.ts:6-11`, `packages/core/src/plugin/serve.ts:22-23`).
   4. A process plugin has the same trust as an in-process one (`docs/plugin-protocol.md:19`).
   5. `serveProcessPlugin` serves an in-process manifest over the protocol (`packages/core/src/plugin/serve.ts:65-89`).
8. The challenge service lets `bazam exec` and every runner target ask for challenge answers. It listens on `127.0.0.1` and answers `POST /challenge` with a bearer token through the env's resolver chain (`packages/core/src/challenge/service.ts:55-103`). [challenge-service.md](challenge-service.md) defines the variables, the request fields and one meaning per status code. A version header on this API is planned for Stage 4 ([ROADMAP.md](../ROADMAP.md)).
9. Adding a contribution type takes a manifest field, an entry in `contributionLists` and a lookup method (`packages/core/src/plugin/registry.ts:99`). Offering it to process plugins also takes a method in `METHODS`, a descriptor key, an entry in the allowlist, a proxy and the describe side (`packages/core/src/plugin/protocol.ts:210-357`, `packages/core/src/plugin/proxies.ts:41-48`, `packages/core/src/plugin/serve.ts:91-117`). Document the type in [plugins.md](plugins.md) or [plugin-protocol.md](plugin-protocol.md) in the same pull request.

**Stable surfaces**

Adopters' case files, configs, scripts, agents and plugins depend on these surfaces. A change to any of them follows the compatibility rules in the next section. A stability page that lists them in the docs is planned for Stage 1 ([ROADMAP.md](../ROADMAP.md)).

1. Config keys: the top-level keys `envs`, `secrets`, `identities`, `roles`, `challenges`, `runners`, `targets`, `trackers`, `plugins` and `redaction` (`packages/core/src/project.ts:158-216`), and every nested key that [configuration.md](configuration.md) documents. A driver target's own settings belong to its driver (`packages/core/src/project.ts:87`).
2. Case fields: `id`, `title`, `stage`, `risk`, `links`, `targets`, `needs`, `tags`, `once`, `prod_safe`, `steps`, `checks`, `finally` and `report` (`packages/core/src/case/schema.ts:229-249`). The case id format (`packages/core/src/case/schema.ts:3-6`), the stages `draft`, `acceptance`, `regression` and `retired` (`packages/core/src/case/schema.ts:7`) and the step marks `as`, `level` and `callout` (`packages/core/src/case/schema.ts:24`) count too.
3. Step kinds: the core kinds above and the web kinds `open`, `tap`, `fill`, `expect`, `screenshot` and `wait` (`packages/driver-web/src/driver.ts:310-360`), with their payload fields.
4. CLI: the commands `init`, `schema`, `check`, `plan`, `run`, `ingest`, `promote`, `retire`, `exec`, `keepalive`, `logout`, `report` (with `plan`, `post` and `ack`), `doctor`, `scan` and `mcp`; the flags in `OPTIONS` (`packages/cli/src/main.ts:39-62`); and the exit codes 0, 1, 2 and 3 (`packages/cli/src/exit.ts:4-13`).
5. Run files under `runs/<run-id>/`: `<case-id>/result.json` with the fields of `CaseResult` (`packages/core/src/result/evidence.ts:25-53`), `post-plan.json` with `runId`, `env`, `createdAt` and `items` (`packages/core/src/report/post-plan.ts:14-40`), `status.json` (`packages/core/src/result/summary.ts:17-31`) and `summary.json` (`packages/core/src/result/summary.ts:37-64`). Outside the run folder, `<stateDir>/receipts.json` (`packages/core/src/report/receipts.ts:20-56`).
6. The comment marker `<markerPrefix>:<case-id>:<run-id>` (`packages/core/src/report/post-plan.ts:15,144`). `report post`, `report ack` and `report_ack` record it in receipts, and `report.comment: update` finds the earlier comment through them (`packages/core/src/report/direct.ts:114`, `packages/cli/src/commands/report.ts:261`, `packages/mcp/src/tools.ts:420`).
7. MCP tools: the 12 names `cases_search`, `case_draft`, `case_check`, `case_promote`, `run_plan`, `run_start`, `run_status`, `evidence_get`, `prompt_list`, `prompt_answer`, `report_plan` and `report_ack`, and their input schemas (`packages/mcp/src/tools.ts:156-426`).
8. Plugin types: `PluginManifest`, `definePlugin`, every contribution interface in the table above, `StepContext` and `PLUGIN_API_VERSION` (`packages/core/src/plugin/registry.ts:24,41-61`, `packages/core/src/driver/driver.ts:14-78`).
9. Process protocol: `PROTOCOL_VERSION`, the method names and shapes in `METHODS`, and the error codes (`packages/core/src/plugin/protocol.ts:17-18,210-357`, `packages/core/src/plugin/rpc.ts:6-11`, `packages/core/src/plugin/serve.ts:22-23`).
10. Challenge service API: the variables `BAZAM_CHALLENGE_URL` and `BAZAM_CHALLENGE_TOKEN`, the request fields and the status codes (`docs/challenge-service.md:5-37`).

**Compatibility and versioning**

1. Until the checkpoint in [ROADMAP.md](../ROADMAP.md), a release only adds. Each item in the list above keeps its name and meaning, and every plugin type keeps its signature.
2. A removal or a rename gets a deprecation warning one minor release ahead, with a migration note. After the checkpoint, breaking changes wait for one announced breaking minor. Planned for Stage 2 ([ROADMAP.md](../ROADMAP.md)): config and case loading warn about deprecated fields, and `bazam check` shows the warnings. The first one is the case field `needs`, which nothing reads (`packages/core/src/case/schema.ts:241`).
3. Mark a breaking change with `!` before the colon in the commit header, such as `feat(core)!: ...`. `scripts/release.ts` lists a commit under Breaking changes only when it sees that `!` (`scripts/release.ts:156-160`). It reads the header alone, so a `BREAKING CHANGE:` footer is not enough. No CI check looks at commit headers, so the author and the reviewer check it.
4. Before 1.0, a breaking change goes in a minor release (`docs/releasing.md:30`).
5. `PLUGIN_API_VERSION` is 1 (`packages/core/src/plugin/registry.ts:24`). Today core refuses any manifest whose `apiVersion` differs, with `PluginApiMismatch` (`packages/core/src/plugin/registry.ts:272-273`). `@bazam/driver-web`, `@bazam/resolvers`, `@bazam/tracker-jira` and the TypeScript plugins in `examples/plugins` write the exported constant. Planned for Stage 2 ([ROADMAP.md](../ROADMAP.md)):
   1. The version stays 1, with v0.6.0 as the baseline.
   2. A plugin writes the number it was built for as a literal, `apiVersion: 1`. The exported constant always equals the installed core's version, so a plugin that writes it passes the check against any core.
   3. Core accepts a range from the oldest supported version to the current one, and warns before it refuses a version.
   4. From then on, a breaking change to any contribution type raises the version. v0.6.0 changed `TrackerRenderer.render` and reserved `level` and `callout` without raising it (`docs/plugins.md:47-50`).
6. `PROTOCOL_VERSION` is 1 (`packages/core/src/plugin/protocol.ts:18`). The host compares it by exact equality before it reads the rest of the `initialize` answer (`packages/core/src/plugin/process.ts:221-227`). It versions the wire format and moves independently of `PLUGIN_API_VERSION`. Keep wire changes additive.
7. `result.json` has no version field. Readers parse it with a bare cast (`packages/core/src/case/stage.ts:107`, `packages/cli/src/commands/report.ts:284`, `packages/mcp/src/tools.ts:311,627`), and only `calloutsOf` handles an older `result.json` that lacks `callouts` (`packages/core/src/report/callouts.ts:11`). A new reader accepts a `result.json` that an older release wrote. Planned for Stage 2 ([ROADMAP.md](../ROADMAP.md)): `result.json` gains a `version` field, and the CLI and the MCP server validate a result when they read it.
8. `post-plan.json`, `status.json` and `summary.json` have no version field either. Treat their field names as fixed.
9. A process tracker plugin receives `trackers.<t>` parsed with the strict `TrackerConfig` schema (`packages/core/src/plugin/protocol.ts:236`, `packages/core/src/project.ts:127`), and `serveProcessPlugin` parses params with that schema (`packages/core/src/plugin/serve.ts:50-51`). A new host-side tracker setting can therefore break an older plugin. Planned for Stage 2 ([ROADMAP.md](../ROADMAP.md)): a process tracker plugin accepts tracker settings it does not know.
10. Planned for Stage 1 ([ROADMAP.md](../ROADMAP.md)): a compatibility job in CI. It loads the last release's example cases and config, reads a sample `result.json` from that release and compares `bazam schema` with the last tag.

**Config and case schema rules**

1. Build every config and case object with `z.strictObject`. An unknown key then fails with its file and line (`packages/core/src/case/schema.ts:229-249`, `packages/core/src/project.ts:158-216`, `packages/core/src/case/load.ts:49,163`).
2. A driver target's settings use `catchall` (`packages/core/src/project.ts:87`), and the driver checks them itself. A process plugin's contributions descriptor is a loose object, so a contribution type that a process plugin cannot offer reaches the host, which refuses it with that type in the message (`packages/core/src/plugin/protocol.ts:54-55`, `packages/core/src/plugin/proxies.ts:60-66`). The host reads `protocolVersion` from the `initialize` answer with a loose object before it parses the rest (`packages/core/src/plugin/process.ts:221-222`).
3. Give a new field a default that keeps today's behavior, as `links`, `tags`, `once`, `prod_safe`, `steps`, `checks` and `finally` have (`packages/core/src/case/schema.ts:239-247`). Make a field required only when a missing value would be unsafe, as `production` is for an env (`packages/core/src/env/environment.ts:46-47`).
4. A case field, step kind or config key that `examples/` uses is never renamed or removed. Deprecate it instead.
5. A step has exactly one kind key, plus the marks `as`, `level` and `callout`. The step mapping is a strict object, and an unknown kind lists the known kinds (`packages/core/src/case/schema.ts:166-175,208-227`).
6. A case id looks like `AUTH-LOGIN-001`: three parts, 3 to 7 digits at the end and no run of more than 7 digits, because the redactor masks longer digit runs (`packages/core/src/case/schema.ts:3-6,232-235`). An id in `cases/.retired` is never reused, and `retireCase` writes the id there before it removes the case (`packages/core/src/case/load.ts:180-222`, `packages/core/src/case/stage.ts:75-84`).
7. Cross-field rules go in `superRefine`, with a message that says how to fix the file, as the role checks do (`packages/core/src/project.ts:218-242`).
8. `bazam schema` prints the JSON Schema built from the zod schemas and the plugins' step kinds (`packages/cli/src/commands/schema.ts:6-11`), so it follows the zod schema. Update [configuration.md](configuration.md) and `examples/` in the same pull request.

**Evidence, secrets and masking**

1. Write run files only through `EvidenceStore` (`packages/core/src/result/evidence.ts:72-171`) and `RunLog` (`packages/core/src/run/finish.ts:102-132`). Both mask through the run's `Redactor`. A step or plugin attaches files with `ctx.evidence.attach` and never writes into `runs/` itself.
2. `attach` masks `txt` and `json` files and writes `png` and `zip` files unchanged (`packages/core/src/result/evidence.ts:109-123,185-195`). The web driver writes the only zips, Playwright traces that it scrubs first (`packages/driver-web/src/driver.ts:547-565`). A process plugin cannot attach a zip (`packages/core/src/plugin/protocol.ts:333-346`).
3. `result.json` is masked except `seed`, `values`, `steps` and `durationMs`, which the harness makes (`packages/core/src/result/evidence.ts:159-166`). Add a field to that list only when no product or secret value can reach it.
4. Register a secret with the redactor as soon as it is read. `resolveSecret` does this for secret providers (`packages/core/src/secrets/provider.ts:22-46`), and an auth strategy returns its credential's secret values from `secrets(credential)` (`packages/core/src/auth/strategy.ts:68-69`). A process resolver's answer is registered only once `resolver.resolve` returns. Never log the answer before that (`docs/plugin-protocol.md:180`).
5. Everything the CLI and the MCP server print passes through the same redactor (`packages/cli/src/io.ts:21-55`, `packages/mcp/src/server.ts:67-95`). Under `bazam mcp`, stdout belongs to the protocol, so log to stderr (`packages/cli/src/commands/mcp.ts:5-9`).
6. Comments are redacted again before `post-plan.json` is written (`packages/core/src/run/finish.ts:63-67`). An attachment that contains a fixture, secret or credential value is withheld from upload, and an attachment path must resolve inside the run folder (`packages/core/src/scan/attachments.ts:16-17,61-67`, `packages/core/src/report/direct.ts:89-92,131-137`).
7. A configured redaction pattern must compile with the `u` flag. A pattern whose repeated group holds another repeat is refused (`packages/core/src/redact/redactor.ts:19,22-42,207-217`).
8. Known limits. A known-limits page and a `SECURITY.md` that cover them are planned for Stage 3 ([ROADMAP.md](../ROADMAP.md)):
   1. Screenshots are masked only by the configured `redaction.screenshotSelectors` (`packages/core/src/redact/redactor.ts:39,148`). `bazam scan` skips PNG and JPEG files (`packages/core/src/scan/evidence-scan.ts:47-51,82,123`), so nothing checks a screenshot after it is taken.
   2. `bazam run` does not scan its own run folder. Run `bazam scan` after it (`packages/cli/src/commands/scan.ts:16-53`). CI runs `scripts/secret-scan.ts` after the acceptance runs (`.github/workflows/ci.yml:257-260`).
   3. Evidence stays in your network until you send it somewhere, such as a tracker, CI artifacts or the model an agent uses.

**Environment safety**

1. Every env sets `production`, which is required, and `hosts`, at least one bare host name, which the loader lower-cases (`packages/core/src/env/environment.ts:44-115`).
2. Every request and every navigation checks its host with `assertHostAllowed`. It matches the host name exactly and ignores ports and schemes (`packages/core/src/env/environment.ts:152-155`). Core checks every HTTP redirect hop (`packages/core/src/driver/http.ts:125`). The web driver checks the `open` step and every browser route (`packages/driver-web/src/driver.ts:312`, `packages/driver-web/src/context.ts:61,201`). A new driver checks every navigation the same way, and a plugin step sends HTTP through `ctx.http`, which applies the allowlist (`docs/plugins.md:9`).
3. A probe sends `GET` or `HEAD` to a host listed in `hosts`, without credentials or redirects, and times out after 5 s. Probes run once before any login, and a failed probe blocks the cases that name its host (`packages/core/src/run/env-probes.ts:8-113`, `packages/core/src/env/environment.ts:29-42,72-86`).
4. In a production env, a case without `prod_safe: true` is refused at plan time (`packages/core/src/run/plan.ts:247-252`).
5. The production write guard `assertProdWrite` refuses any method other than `GET` in a production env unless the step sets `write: true` (`packages/core/src/env/environment.ts:161-169`). It reaches HTTP only:
   1. Covered: the core `request` step and `api` check (`packages/core/src/driver/http.ts:246,269`), `host.http` from a process plugin (`packages/core/src/plugin/process.ts:310`), and plan checks, which refuse every method except `GET` and `HEAD` (`packages/core/src/run/plan-checks.ts:56-63`).
   2. Not covered: browser steps such as clicks, fills and form posts, and external suites. An in-process plugin step calls `assertProdWrite(ctx.env, method, { write })` itself before it sends (`docs/plugins.md:9`).
6. An external runner without `prodSafe` asks a person for a yes before it runs in a production env. A no, or no answer, blocks its cases (`packages/core/src/run/runner.ts:495-523`). Unattended CI runs a production suite only with `prodSafe` (`docs/external-runners.md:98`).
7. The check rule `prod-safe` flags a request step in a `prod_safe` case that sends a method other than `GET` without `write: true` (`packages/core/src/check/rules.ts:76,404-412`).

**Errors, case status and exit codes**

1. A case ends `pass`, `fail`, `blocked` or `followup` (`packages/core/src/result/status.ts:1`).
2. The error class decides the outcome (`packages/core/src/run/outcome.ts:45-71`):
   1. A product failure throws `StepFailed`, and the case fails.
   2. An environment, test data or credential problem throws an error from the `BLOCKING` list, such as `CaseBlocked`, and the case is blocked with its message. A new blocking error class goes into `BLOCKING`.
   3. Any other throw is a harness error. The case is blocked with the reason prefixed `internal:`, so a bazam bug never reads as a product bug.
3. Inside a step, a throw that is not blocking, `PluginCallFailed`, `HarnessError` or `SessionLost` becomes `StepFailed` (`packages/core/src/run/case-run.ts:303-315`). `SessionLost` reruns the step once after the session is recovered, and a second one blocks the case (`packages/core/src/run/case-run.ts:316-331`).
4. `deriveStatus` tries these rules in order and stops at the first match (`packages/core/src/result/status.ts:22-30`):
   1. A failed check makes the case `fail`, whatever the outcome.
   2. A blocked outcome makes it `blocked`.
   3. An error blocks the case when the harness caused it and fails it when the product did.
   4. A case without checks fails.
   5. A follow-up check gives `followup`.
   6. Any other case passes.
5. Plan-time problems, such as a refused case, a failed login or an unreachable probe host, block the case before any driver launches (`packages/core/src/run/runner.ts:644-647`). A plan check that throws blocks every case it was given with `internal: plan check <name> failed: <message>` (`packages/core/src/run/plan-checks.ts:82,89`).
6. `finally` steps always run, under their own budget of 2 minutes that a cancel does not abort. A failure or a check inside them becomes a note (`packages/core/src/run/case-run.ts:50,165-192,229-267`).
7. For an external runner, a case with no test result is blocked, a failed or errored test fails the case through a failed check, and a skipped test blocks it (`packages/core/src/ingest/record.ts:58,97-114`).
8. Exit codes (`packages/cli/src/exit.ts:4-13`):
   1. 0: every case passed.
   2. 1: at least one case failed, whatever the other statuses are.
   3. 3: a case is blocked or needs a follow-up, and none failed.
   4. 2: the command could not start or could not do its work. `CommandError`, an unknown flag or command, a config that does not load, `PluginConflict`, `PluginApiMismatch` and any other throw a command does not catch end here (`packages/cli/src/main.ts:165-228`).
   5. `bazam scan` exits 1 on any finding, and `bazam exec` returns the exit code of the command it ran.
9. Known gap: `HumanOnlyViolation` is not in `BLOCKING`, so a throw during a run ends the case blocked as a harness error (`packages/core/src/challenge/policy.ts:5-25`, `packages/core/src/run/outcome.ts:45-58`).
10. The docs quote the texts of `PluginConflict`, `PluginApiMismatch` and the protocol version error (`docs/plugin-protocol.md:64-65`). Change those texts only together with the docs (`packages/core/src/plugin/registry.ts:63-87`, `packages/core/src/plugin/process.ts:225`).

**Concurrency and state**

1. `--workers` takes a whole number from 1 to 16 and defaults to 1 (`packages/cli/src/commands/run.ts:14,58-67`).
2. The runner builds one work unit per case, and one per runner target for its external suite (`packages/core/src/run/runner.ts:785-803`).
3. Each unit takes named locks, and a unit starts only when no running unit has any of its locks (`packages/core/src/run/schedule.ts:12-60`):
   1. A case locks each identity it acts as or logs in as, and a blocked case takes no locks (`packages/core/src/run/runner.ts:860-863`).
   2. An external suite locks the runner's listed identities, or all identities when it lists none, plus `runner:<name>`, and `results:<a>+<b>` for each other runner whose result glob can overlap (`packages/core/src/run/runner.ts:805-822`).
4. A free worker takes the first waiting unit whose locks are free, so cases may start out of plan order. Results still come back in plan order (`packages/core/src/run/schedule.ts:12-17`). Write each case so it passes in any order. Dependencies between cases are not planned ([ROADMAP.md](../ROADMAP.md)).
5. Cases don't share state. Each case gets its own `CaseEvidence`, `CaseValues` and seeded random stream, and `${case.<name>}` resolves only inside its own case (`packages/core/src/run/case-values.ts:1-20`, `packages/core/src/env/run-values.ts:28-53`, `packages/core/src/run/runner.ts:445-447,465-466`). Keep per-case state in these objects, never in module-level variables.
6. The web driver shares one browser across cases for each combination of the `browser`, `channel`, `headless` and `args` settings, and each case's session opens its own contexts and closes them when the case ends (`packages/driver-web/src/driver.ts:100-127,481-530`).
7. Credential refresh takes a lock file per env, identity and surface, across processes. The holder writes a heartbeat. A lock untouched for 2 minutes, or held by a process that no longer runs, is taken over, and a waiter gives up after 150 s with `RefreshLockTimeout`, which blocks the case (`packages/core/src/auth/lock.ts:7-10,26-61`).
8. The run shows the person one prompt at a time, under `--workers` too (`packages/core/src/challenge/human.ts:41`, `docs/challenge-service.md:81`).
9. `status.json` and `receipts.json` are written to a temp file and renamed into place (`packages/core/src/result/summary.ts:25-31`, `packages/core/src/report/receipts.ts:51-55`). `ProgressFile` serializes its writes (`packages/core/src/run/finish.ts:145-152`).
10. A unit that throws stops the run. No new unit starts, the run waits for the running units, and a case the stop interrupts ends blocked with `run cancelled` (`packages/core/src/run/schedule.ts:48-58`, `packages/core/src/run/runner.ts:375-377,683`, `packages/core/src/run/outcome.ts:66`).
11. Still open for Stage 2 ([ROADMAP.md](../ROADMAP.md)): a named lock besides identities, so cases that change one global setting, such as a feature flag on an admin page, never run concurrently. Until it exists, run such cases with `--workers 1` or make them act as the same identity.

**Testing and CI**

1. Unit tests live in `packages/<pkg>/test/**/*.test.ts` and `scripts/test/**/*.test.ts`, and `pnpm test` runs them (`vite.config.ts:11-14`). A change in a package comes with tests in that package's `test/` folder.
2. The pre-commit hook runs `vp staged`, and the pre-push hook runs `pnpm check && pnpm test`. Do not skip them with `--no-verify` (`CONTRIBUTING.md:9-14`).
3. CI in `.github/workflows/ci.yml` has three jobs:
   1. `checks` builds, typechecks, runs `pnpm check` and `pnpm brand:check`, and runs the tests with Chromium, Firefox and WebKit installed (`.github/workflows/ci.yml:29-106`).
   2. `install` packs every package and installs the tarballs in empty folders with npm and with pnpm, with exactly one `@bazam/core` (`.github/workflows/ci.yml:108-129`, `docs/releasing.md:113-115`).
   3. `acceptance` starts the demo app with docker compose, runs the example project on Chromium, Firefox and WebKit, runs the `node:test` external suite and scans the run folders for secrets. It uploads the evidence of a failed run only after a clean scan (`.github/workflows/ci.yml:131-270`).
4. `examples/` is the acceptance project and the reference for adopters. A new case field, step kind, config key or plugin type gets a use there. The acceptance job then runs it.
5. Engine-specific tests use `it.skipIf` or `it.runIf` with the engine in the condition, and the platform when it matters (`packages/driver-web/test/driver.test.ts:544,594,924,937`). Each skip says why next to the test, and a limit that users can hit also goes in the docs. Planned for Stage 3 ([ROADMAP.md](../ROADMAP.md)): a deterministic test for the WebKit race at close time, or a documented limit.
6. Code in `packages/*/src` builds the product name from `BRAND` (`packages/core/src/brand.ts`), and `pnpm brand:check` fails on the spelled-out name (`scripts/brand-check.ts`, `CONTRIBUTING.md:15`).
7. Reviewers check by hand that core doesn't import Playwright or an MCP library and that dependencies point toward core, because no automated test covers the package boundaries.
8. Planned for Stage 1 ([ROADMAP.md](../ROADMAP.md)): the compatibility job described under Compatibility and versioning. It and the `install` job become required checks.

**Docs and release rules**

1. Docs change in the same pull request as the behavior: config keys in [configuration.md](configuration.md), in-process plugin contracts in [plugins.md](plugins.md), the process protocol in [plugin-protocol.md](plugin-protocol.md), runner targets and `bazam ingest` in [external-runners.md](external-runners.md), the challenge service in [challenge-service.md](challenge-service.md), CI use in [ci-regression.md](ci-regression.md) and the release flow in [releasing.md](releasing.md).
2. Docs use bold section headings with numbered lists, plain sentences and straight quotes, with no em or en dashes.
3. A breaking change gets a migration note in the docs, as the section "Breaking changes in v0.6.0" in [plugins.md](plugins.md) has (`docs/plugins.md:47-50`).
4. Known doc gaps to fix when you touch those pages:
   1. [plugins.md](plugins.md) names only some of the reserved step kinds (`docs/plugins.md:19,50`, against `packages/core/src/plugin/registry.ts:28-38`).
   2. No page tells an in-process plugin author about `apiVersion`.
   3. The comment on `PluginApiMismatch` speaks of a major version, while the check is exact equality on one number (`packages/core/src/plugin/registry.ts:74,272`).
5. Versions live only in tags, and `main` keeps `0.0.0` in every `package.json` (`docs/releasing.md:3`).
6. [ROADMAP.md](../ROADMAP.md) sets the release cadence, which the Release workflow does not enforce today: every minor release goes out as a release candidate first (`bump=rc`) for adopters to run their suites on, each minor has one theme, and minors come at least 14 days apart. `final` releases the candidate's own commit (`docs/releasing.md:26-27`).
7. A patch goes out from a `release/<x>.<y>` branch cut from the final tag whenever `main` holds unreleased features (`docs/releasing.md:39-51`). Planned for Stage 1 ([ROADMAP.md](../ROADMAP.md)): the Release workflow refuses `minor` on `main` once a final release exists, and refuses `patch` on `main` when a `feat` commit was merged after the last release.
8. Commit headers follow Conventional Commits, because the release notes group commits by type (`docs/releasing.md:55-57`). Sign off each commit for the DCO with `git commit -s` (`CONTRIBUTING.md:3-7`).
