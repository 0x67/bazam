# CI regression and promotion

Two GitHub Actions workflows in `examples/ci/` run a bazam project in CI. `regression.yml` runs the regression suite and posts the results to the tracker. `promote.yml` moves acceptance cases to regression once their linked tickets are done, through a pull request that someone reviews. Both expect `bazam.config.yaml` at the root of the repository.

**What the workflows do**

1. `regression.yml` runs on a push to the default branch, every night at 02:17 UTC and by hand. It runs `bazam run --env staging --suite regression --workers 4 --channel answers-file` with the run id `regression-<run number>-<attempt>`, so a re-run gets a fresh folder and a fresh marker. The id leaves out the Actions run id because the default redaction rule masks any run of 8 or more digits, so an id holding that 11-digit number would appear masked in `result.json`, in the markers and in the comments. `bazam report post` then comments on the linked tickets of each case that failed or was blocked; a passing case posts nothing on its tickets. For a project with `bugs`, it files a bug when a regression case fails, or comments on the open bug the case already has, and comments on that bug when the case passes again. When the run failed, the job uploads `runs/` as the artifact `regression-runs`, kept 7 days, and then fails.
2. `promote.yml` runs every Monday at 04:23 UTC and by hand, in three jobs. The `acceptance` job runs the acceptance suite and uploads `runs/` as the artifact `acceptance-runs`, kept 1 day. The `promote` job downloads those runs and runs `bazam promote --from-tracker --env staging --json`. When a case file changed, it uploads the change as a patch, together with a pull request body that lists the promoted cases and why each other case stayed, as the artifact `promotion`, kept 1 day. The `pull-request` job then applies the patch, commits it on a new branch `bazam/promote-<UTC date and time>` and opens the pull request.
3. Failed and blocked cases stay in acceptance. The acceptance step passes on exit codes 0, 1 and 3, so one failing case does not hold back the others, and promotion still needs each case's latest result in the env to pass. Any other exit code, such as 2 for a run that could not start, fails the workflow.
4. When no acceptance case is left, `bazam run` exits 2 with `no case matches the selection`. The step then ends green, and the upload and the `promote` and `pull-request` jobs are skipped.
5. Neither workflow runs on `pull_request`. Actions secrets do not reach pull requests from forks, and a regression run on a pull request would post results for code that is not merged.
6. Both workflows set `concurrency` per branch and never cancel a run in progress, so two runs never post at once and a run that started finishes its posts. Keep one regression job per branch: `report post` looks for an open bug right before it files one, so two jobs posting at the same moment can file the same bug twice.

**Copying the workflows**

1. Copy `examples/ci/regression.yml` and `examples/ci/promote.yml` to `.github/workflows/` in your project.
2. Replace `staging` with an env from your `bazam.config.yaml`. In `promote.yml` it appears in the `acceptance` and `promote` jobs.
3. Replace the suites `regression` and `acceptance` if yours have other names.
4. In `regression.yml`, replace `main` in the push filter with your default branch, since a push filter cannot name the default branch for you.
5. A suite with external cases (see [external-runners.md](external-runners.md)) needs its runner's toolchain in the job, such as `actions/setup-java` for a Maven suite. Add that step before `bazam run`.
6. The workflows install only Chromium. When a suite or a case runs on a target that sets `browser: firefox` or `browser: webkit`, add that browser to the `playwright install --with-deps chromium` step of every job that runs tests, as in `playwright install --with-deps chromium firefox`. In `promote.yml` that is the `acceptance` job.

**Setup**

1. bazam is not on npm. Install the six tarballs of a bazam release by URL, together with Playwright, in the project that holds `bazam.config.yaml`. Pick a release that has `report post` and `promote --from-tracker`, so 0.2.0 or later. Then commit `package.json` and `package-lock.json`:

   ```sh
   version=0.2.0
   base=https://github.com/0x67/bazam/releases/download/v$version
   npm install --save-dev "$base/bazam-$version.tgz" "$base/bazam-core-$version.tgz" \
     "$base/bazam-driver-web-$version.tgz" "$base/bazam-mcp-$version.tgz" \
     "$base/bazam-resolvers-$version.tgz" "$base/bazam-tracker-jira-$version.tgz" playwright
   ```

2. The `regression`, `acceptance` and `promote` jobs run `npm ci --ignore-scripts`. No package in that install needs an install script, and the browser comes from `playwright install --with-deps chromium`.
3. The jobs that run tests put `node_modules/.bin` first on `PATH`, so their steps call `bazam` and `playwright` by name. In every later step of those jobs, a bin from that install named like a system command, such as `mkdir`, `jq` or `sudo`, runs in place of that command. That includes the step that writes the app secrets. `--ignore-scripts` does not stop npm from linking those bins, so review what `package-lock.json` installs, or remove the step that changes `PATH` and call `node_modules/.bin/bazam` and `node_modules/.bin/playwright` by path.
4. The `promote` job leaves `PATH` as it is and calls `node_modules/.bin/bazam`, so no installed bin can shadow `git` or `jq` by name in that job. Its token can only read the repository, but the job holds the tracker secrets, and the code `bazam promote` loads (its dependencies and the plugins in `bazam.config.yaml`) runs beside them. Keep `package-lock.json` committed and protect the default branch.
5. The `pull-request` job holds the token that can push and open pull requests. Code in a job can read that job's token from the runner's memory, so this job sets up no Node, installs nothing, runs no bazam and reads no secret. It applies the patch from the `promote` job with `git apply --index`. A dependency in the `promote` job could have written that patch, so the job fails without pushing when the patch changes anything other than YAML files under `cases/`, counting both paths of a rename. The job also refuses a case file whose name holds a tab, a newline, a double quote or a backslash, because git prints that name in quotes.
6. No step calls `npx bazam`. bazam does not hold the npm name `bazam`, and in CI `npx` installs a missing package without asking, so `npx bazam` would download and run whatever package has that name.
7. The project config needs these keys, which [configuration.md](configuration.md) describes:
   1. The env the workflows name, and the suites `regression` and `acceptance` in `suites.yaml`, such as `regression: { stages: [regression] }` and `acceptance: { stages: [acceptance] }`.
   2. `env` and `dotenv` in `secrets.providers`, as the default has them. The tracker credentials arrive as environment variables and the app secrets in `.bazam/secrets.env`.
   3. `trackers.jira.site`, and `trackers.jira.secrets: { email: JIRA_EMAIL, token: JIRA_API_TOKEN }`.
   4. `bugs` under `trackers.jira.projects.<p>` for the bugs `report post` files, and `promoteOn` for the ticket statuses that let a case graduate.

   ```yaml
   trackers:
     jira:
       site: example.atlassian.net
       secrets: { email: JIRA_EMAIL, token: JIRA_API_TOKEN }
       projects:
         DEMO:
           bugs: { issueType: Bug, labels: [regression] }
           promoteOn: [Done, Released]
   ```

**Repository secrets**

1. `BAZAM_IDENTITIES` holds your `fixtures/identities.local.yaml`, the local fixtures YAML that git ignores.
2. `BAZAM_SECRETS_ENV` holds one `NAME=value` line for every name under `secrets.names`, as `.bazam/secrets.env` holds them.
3. Both are repository secrets (Settings, Secrets and variables, Actions), since the `acceptance` job runs in no environment. From a checkout that holds both files:

   ```sh
   gh secret set BAZAM_IDENTITIES < fixtures/identities.local.yaml
   gh secret set BAZAM_SECRETS_ENV < .bazam/secrets.env
   ```

4. The step "Prepare the project" writes both files before `bazam run`. A project without identity fixtures or secret names can leave either secret unset.

**Repository settings**

1. Allow Actions to create pull requests: Settings, Actions, General, Workflow permissions, "Allow GitHub Actions to create and approve pull requests". It is off by default for personal repositories, and without it `gh pr create` is refused even with `pull-requests: write`.
2. Since 2026-06-11, a pull request opened with `GITHUB_TOKEN` starts its `pull_request` runs only after someone with write access approves them. For CI that starts on its own, pass a GitHub App installation token as `GH_TOKEN` in the step that opens the pull request.
3. Create the `tracker` environment: Settings, Environments, New environment, named `tracker`. Under deployment branches and tags, pick "Selected branches and tags" and add only the default branch. Add the environment secrets `JIRA_EMAIL` and `JIRA_API_TOKEN`, or set them with `gh secret set JIRA_API_TOKEN --env tracker`.
4. The `regression` and `promote` jobs declare that environment, so in a run dispatched from another branch GitHub refuses them before any of their steps runs. Inside those jobs, the tracker secrets reach only the step that posts or promotes.

**What others can see**

1. Anyone signed in to GitHub can download the artifacts of a public repository: the regression evidence for 7 days, and the acceptance runs and the promotion patch for 1 day. The evidence and the acceptance runs hold screenshots, traces, logs and results.
2. bazam masks the evidence it writes. It copies the screenshots of external suites as their runner wrote them, without masking.

**GitHub limits**

1. Scheduled workflows run only on the default branch.
2. In a public repository, GitHub turns a schedule off after 60 days without activity. Turn it back on from the workflow's page under Actions.

**Tokens and production**

1. Jira API tokens expire within 365 days. On a 401, `report post` and `promote` say to check that the token has not expired. Create a new token and replace `JIRA_API_TOKEN` in the `tracker` environment.
2. A scoped token calls Jira through `https://api.atlassian.com/ex/jira/<cloudId>`, so set `trackers.jira.api` to that URL. The 401 message says this too.
3. Nobody answers a person prompt in CI. With `--channel answers-file`, a case that asks a person waits out the prompt's window (five minutes for a challenge, fifteen for a guided step) and ends blocked.
4. In a production env (`production: true`), a runner without `prodSafe: true` asks a person to confirm the run first, so in CI its cases end blocked. Set `prodSafe: true` only on a runner whose suite is safe to run against production.
