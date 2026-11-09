# External runners

A runner target runs a suite written for another framework, such as Selenium with JUnit, pytest, Playwright Test, Cypress or Node's test runner, and records its tests as bazam cases. `bazam run` starts the suite under the [challenge service](challenge-service.md), reads the result files it writes and maps each test to a case by the id in its name. Each external case then gets a `result.json`, a line in the summary and a post plan item, as a YAML case does.

**Runner config**

```yaml
runners:
  shop-selenium:
    command: [mvn, -q, test]
    cwd: ../shop-tests
    results: target/surefire-reports/TEST-*.xml
    format: junit
    mapping: mappings/shop-selenium.yaml
    env: { BASE_URL: "${env.SHOP_URL}" }
    timeoutMinutes: 30
    identities: [customer]

targets:
  web: { driver: playwright }
  shop-chrome: { runner: shop-selenium, env: { BROWSER: chrome } }
  shop-firefox: { runner: shop-selenium, env: { BROWSER: firefox } }
```

1. `command` (required): the program and its arguments, run without a shell. Write `[sh, -c, "..."]` when the suite needs one.
2. `cwd`: the folder the command runs in, relative to the project root, `.` when left out.
3. `results` (required): a glob for the result files, relative to `cwd`. `*` matches within one folder and `**` matches across folders.
4. `format` (required): `junit`, `playwright-json`, or a result format a plugin registers. `bazam check` reports any other name under `runner-format-known`.
5. `mapping`: a mapping file, relative to the project root, for tests whose names cannot hold a case id (see "Mapping tests to cases").
6. `env`: variables added to the suite's environment. Values take `${env.NAME}`, `${secret.NAME}` and `${run.…}` placeholders: `${run.id}`, `${run.time}` and `${run.random(min, max, decimals)}`. A suite belongs to no case and acts as no identity, so `${case.…}` and `${identity.…}` do not resolve here.
7. `timeoutMinutes`: 60 when left out.
8. `prodSafe`: `false` when left out (see "Production").
9. `identities`: the identities the suite's tests act as, every identity in the config when left out. With `--workers`, the suite holds the lock of each one it lists and of `runner:<name>`, so no case that acts as one of them runs beside it. `identities: []` holds only the runner's own lock.

A runner name takes letters, digits, dots, dashes and underscores, starting with a letter or digit.

**Runner targets**

1. A target names a driver or a runner. A runner target holds `runner` and an optional `env` and nothing else. Its `env` adds to the runner's `env` and wins on a name both set.
2. Several targets can share one runner, such as one per browser. Each target with selected cases runs the suite once.
3. `bazam check` reports these with their file and line, and other commands, such as `plan` and `run`, refuse to start on them with exit 2:
   1. `a target names a driver or a runner, not both`
   2. `runner <name> is not defined under runners`
   3. `runner <name> lists identity <id>, which is not defined under identities`
   4. `a runner target's name takes letters, digits, dots, dashes and underscores, starting with a letter or digit`, because the name becomes the folder `runs/<run-id>/runner-<target>/`

**External cases**

An external case has no `steps` and no `checks`, since its checks come from the runner's tests, and lists only runner targets:

```yaml
cases:
  - id: SHOP-CART-001
    title: Cart keeps items after sign-in
    stage: acceptance
    risk: medium
    links: [jira:DEMO-12]
    targets: [shop-chrome, shop-firefox]
```

`bazam check` reports a case that breaks this under `external-case-shape`, and `bazam run` blocks it with the same message: `<id> lists runner targets (<a>) and driver targets (<b>)`, or `<id> runs on runner target <target> but has steps` (or `but has checks`).

**What a run does**

1. The run starts the challenge service before the first suite, then starts each runner target's command once, with every selected case of that target that the plan did not block. A runner whose selected cases are all blocked never starts.
2. The suite's environment is the run's own environment, then the runner's `env`, then the target's `env`, then five variables: `BAZAM_CHALLENGE_URL`, `BAZAM_CHALLENGE_TOKEN`, `BAZAM_RUN_ID`, `BAZAM_ENV` and `BAZAM_CASES`. Every variable named in a `trackers.<tracker>.secrets` value is removed. A placeholder that does not resolve blocks the target's cases with `unresolved placeholder <placeholder>`, and nothing starts.
3. Before the suite starts, the run registers with its redactor the inherited value of each declared secret: `secrets.names`, each tracker's `secrets` and each `${secret.NAME}` the identities use. The challenge service registers every answer it gives. Each line the suite writes to stdout or stderr is masked, appended to `runs/<run-id>/runner-<target>/runner.log` and written to `run.log` as `[<target>] <line>`. The suite gets no stdin.
4. After the suite exits, the run expands `results` in `cwd` and reads the regular files written since the start, less 2 seconds for file systems with coarse timestamps. Older matches stay where they are, since they belong to the suite, and `run.log` lists each as `[<target>] skipped <file>: written before this run's runner started`. A file that another target of the same run already read, and that has not changed since, is skipped as `[<target>] skipped <file>: another target of this run already read it, and it has not changed since`, so two targets of one runner never read each other's results.
5. Once the suite wrote result files, its exit code decides nothing, since a suite with failing tests exits nonzero. The tests in the files decide each case:
   1. one check per test that did not skip, named by the test's title, with `observed` set to `passed`, `failed` or `errored`, or to `passed after 1 retry` (`passed after <N> retries`) for a test that passed on a rerun;
   2. any failed or errored test fails the case;
   3. otherwise any skipped test blocks it with `skipped: <titles>`;
   4. otherwise it passes.
6. A case with no test in the files is blocked with one of these reasons:
   1. `runner <name> exited <code> and wrote no results matching <glob>`, or `runner <name> was stopped by <signal> and wrote no results matching <glob>`;
   2. `runner <name> could not start: <message>`, such as `spawn mvn ENOENT`;
   3. `runner <name> timed out after <N> min`;
   4. `run cancelled`;
   5. the first parse error, when no result file parses;
   6. `no result from runner <name> for <case-id>`, when the files hold tests but none of that case.
7. `timeoutMinutes` sends SIGTERM, then SIGKILL 10 seconds later. The run still reads the files written before the timeout, so cases with results keep them. A cancel sends SIGINT and reads no files. Once the suite exits, the run waits at most 5 seconds for its output to close, so a process the suite left running in the background cannot hold the run open.
8. Each challenge the service answered lands in the `challenges` of the case whose id the request named.
9. `bazam plan` prints `runner <name>: <command>` under each external case.

**Attachments**

1. JUnit testcases name attachments in `[[ATTACHMENT|<path>]]` lines of their `system-out` or `system-err`. The Playwright junit reporter writes one such line for each attachment that has a path. `mocha-junit-reporter` writes them only when `attachments=true` is in its `--reporter-options`, for the paths a test puts in `this.test.attachments`. Playwright JSON gives the attachments of a test's last result that have a path.
2. A relative path resolves against the result file's folder, then against the runner's `cwd`.
3. The run copies `.png` files as images, `.txt` and `.log` as text and `.json` as JSON, each up to 20 MiB. It masks text and JSON as it masks a YAML case's evidence and copies images unchanged.
4. It copies a file only when it sits inside the runner's `cwd`, outside the project's `.bazam` and `runs` folders, and was written during the run.
5. Otherwise the case gets a note: `left out <name>: <ext> files from a runner are not copied` (such as `zip files` for Playwright traces and `webm files` for its videos, which bazam cannot scrub), `left out <name>: not a file this runner wrote`, `left out <name>: larger than 20 MiB`, `left out <name>: not valid JSON` or `attachment <name> was not found`.

**Production**

1. In an env with `production: true`, an external case needs `prod_safe: true`, as a YAML case does. Without it the case is blocked with `case <id> is not prod_safe and env <env> is production`.
2. For a runner without `prodSafe: true`, the run asks once, before the runner starts: "Run runner <name> against production env <env>?", answered y or n. `bazam plan` lists `needs a yes before it runs in production env <env>: runner <name>`.
3. A no, or no answer within five minutes, blocks the runner's cases with `production run of runner <name> was not confirmed`, followed by `: <note>` when the person wrote one.
4. bazam cannot hold the suite's process to the host allowlist or the production write guard. Set `prodSafe: true` only when the suite runs just the tests named in `BAZAM_CASES` and the team accepts the suite in production. Unattended CI has nobody to answer the question, so it runs a production suite only with `prodSafe`.

**Mapping tests to cases**

1. A test's case id is the first `[<case id>]` in its title, such as `[SHOP-CART-001]`. The run looks in the test's own name first, then in the names of the suites around it from the inside out.
2. Then a tag `@<case id>` or `<case id>`. Playwright JSON gives tags; JUnit XML has none.
3. Then the mapping file:

   ```yaml
   # mappings/shop-selenium.yaml
   tests:
     "com.shop.CartTest › keepsItemsAfterSignIn": SHOP-CART-001
   ```

   Each key is a test title: the suite names from the outside in, then the test's name, joined by `›` with a space on each side. For Surefire, pytest and Playwright's junit reporter that is `<classname> › <name>`. Node's reporter gives the names of the enclosing `describe` blocks, then the test's name, so a test at the top of a file is its name alone. `mocha-junit-reporter` gives its full title alone, the suite and test names joined by spaces. A Playwright project name is not part of the key, unless the junit reporter's `includeProjectInTestName` option writes it into the test's name.

4. A test the run cannot place goes into `summary.json` under `unmapped` and into `summary.md` under "Unmapped tests", with one of these reasons: `no case id in the test name, its tags or the mapping file`, `no case <id>`, or `case <id> does not run on target <target>`.
5. A test of a case the run did not select is only counted, and `run.log` says `[<target>] <N> tests belong to cases this run did not select` (or `1 test belongs to a case this run did not select`). Nothing posts it.
6. `bazam check` checks mapping files under `runner-mapping-valid`: `mapping file <path> of runner <name> is missing`, a file that does not match the schema, `test "<title>" maps to <id>, which no case declares`, and `test "<title>" maps to case <id>, which does not run on a target of runner <name>`. `no-literal-secret` skips mapping files, since their keys are test titles.

**Variables**

1. `BAZAM_RUN_ID`: the run id, which names the run's folder under `runs/`.
2. `BAZAM_ENV`: the env name.
3. `BAZAM_CASES`: the target's selected case ids that the plan did not block, comma separated, in plan order. A suite may run only these tests and skip the rest, as the example suite does. Never skip the test of a selected case: that case ends blocked with `skipped: <title>`. A skipped test of a case the run did not select only counts as outside the selection.
4. `BAZAM_CHALLENGE_URL` and `BAZAM_CHALLENGE_TOKEN`: the endpoint and token of the challenge service, described in [challenge-service.md](challenge-service.md).

**Reporter flags**

1. Maven Surefire 3 writes `target/surefire-reports/TEST-*.xml` with no flag; use `format: junit`. A Java method name cannot hold `[SHOP-CART-001]`, so either list the tests in a mapping file or let JUnit 5 display names reach the report, with `@DisplayName("[SHOP-CART-001] keeps items after sign-in")` on the test:

   ```xml
   <plugin>
     <groupId>org.apache.maven.plugins</groupId>
     <artifactId>maven-surefire-plugin</artifactId>
     <configuration>
       <statelessTestsetReporter implementation="org.apache.maven.plugin.surefire.extensions.junit5.JUnit5Xml30StatelessReporter">
         <usePhrasedTestCaseMethodName>true</usePhrasedTestCaseMethodName>
       </statelessTestsetReporter>
     </configuration>
   </plugin>
   ```

2. pytest: `command: [pytest, --junitxml=results/junit.xml]` with `results: results/junit.xml` and `format: junit`. A parametrize id puts the case id in the name, as in `test_login[SHOP-LOGIN-001]` from `@pytest.mark.parametrize("plan", ["basic"], ids=["SHOP-LOGIN-001"])`.
3. Playwright Test with `format: playwright-json`: `command: [npx, playwright, test, --reporter=json]`, with `PLAYWRIGHT_JSON_OUTPUT_FILE: results/report.json` in the runner's `env` (or `outputFile` in the reporter options of `playwright.config.ts`) and `results: results/report.json`. The JSON report keeps tags, so `test("keeps items", { tag: "@SHOP-CART-001" }, ...)` maps by tag; it keeps project names, which prefix titles as `[<project>] `, and retries. With `format: junit`, use `--reporter=junit` and `PLAYWRIGHT_JUNIT_OUTPUT_FILE` instead. The junit report has no tags, and by default it writes a flaky test as a plain pass with no retries. To keep retries, set `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES: "1"` in the runner's `env` (or `includeRetries: true` in the junit reporter options of `playwright.config.ts`). The report then gives a flaky test a `flakyFailure` or `flakyError` for each failed attempt, and bazam counts each one as a retry.
4. Cypress or Mocha with `mocha-junit-reporter`: `--reporter mocha-junit-reporter --reporter-options mochaFile=results/junit-[hash].xml`, with `results: results/junit-*.xml` and `format: junit`. Cypress writes one file per spec, and `[hash]` keeps them apart. Files from earlier runs stay in the folder and are skipped by time; to keep `run.log` short, clear the folder in the command, as in `[sh, -c, "rm -rf results && npx cypress run --reporter mocha-junit-reporter --reporter-options mochaFile=results/junit-[hash].xml"]`.
5. Node's test runner takes one destination per reporter, so spec output for `runner.log` and JUnit XML for bazam need two pairs: `[node, --test, --test-reporter=spec, --test-reporter-destination=stdout, --test-reporter=junit, --test-reporter-destination=junit.xml, <test file>]`. Node does not create a missing folder for the destination and exits with ENOENT, so write the report into `cwd` or into a folder that exists in a fresh checkout.

**bazam ingest**

```
bazam ingest --env <env> --target <target> [selection] [--run <id>] <files...>
```

1. It records the cases of one runner target from result files written elsewhere, as a run of those cases would, and starts no process. The target gives the format, the mapping file and the folder that attachments resolve against. Its runner still needs a `command`, which `ingest` never runs.
2. File paths are relative to the working directory. Attachments resolve as in a run, against the result file's folder and then the runner's `cwd`, with the same exclusions, without the rule on when a file was written.
3. It asks no production question, and `prod_safe` still applies to each case.
4. It exits as `run` does: 0 when every case passed, 1 when any failed, 3 when any is blocked or needs follow-up, and 2 when it cannot start.
5. It refuses to start, with exit 2, with these messages:
   1. `ingest takes one --target, the runner target whose runner wrote the files`
   2. `name the result files to ingest`
   3. `target <target> names a driver, not a runner`
   4. `cannot read the result file <file>: <message>`
   5. `run <id> has already started; pick another --run id`
   6. `no case matches the selection`, which is also what a target missing from `targets` usually gets, since the selection keeps only the cases that list the named target.

**Running a suite yourself, then ingesting**

`bazam exec` runs any command under the challenge service, so a suite can run outside a runner target and report through `ingest`. From the project root of the config above:

```sh
BASE_URL=https://shop.example.test BROWSER=chrome bazam exec --env staging -- mvn -q -f ../shop-tests/pom.xml test
bazam ingest --env staging --target shop-chrome ../shop-tests/target/surefire-reports/TEST-*.xml
```

1. Run `ingest` whatever `exec` exits with, since a suite with failing tests exits nonzero.
2. `exec` sets only `BAZAM_CHALLENGE_URL` and `BAZAM_CHALLENGE_TOKEN`. A suite that reads `BAZAM_RUN_ID`, `BAZAM_ENV` or `BAZAM_CASES` needs a runner target.
3. `exec` applies neither the runner's `env` nor the target's, so set those variables yourself, as the example does for `BASE_URL` (the value of `SHOP_URL` in env `staging`) and `BROWSER`.

**Example**

1. The example project runs a `node:test` suite through runner `demo-node-test` in `examples/bazam.config.yaml`. Its two tests, in `examples/external/node-test/email-code.test.ts`, sign in to the demo app over HTTP and get the mailed code through `examples/clients/ts/challenge-client.ts`. They belong to the cases in `examples/cases/api/email-code.yaml`.
2. With the demo app up and after `pnpm build`, run it from the repository root: `pnpm exec bazam run --root examples --env demo --target node-test`. The repository's CI runs it in its acceptance job with `--channel answers-file`, so a challenge that falls back to a person does not wait on a terminal.
3. [ci-regression.md](ci-regression.md) shows the workflows that run a project's regression and acceptance stages in another repository's CI.
