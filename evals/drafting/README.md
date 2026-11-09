# Drafting eval

Measures how well an agent drafts cases from tickets with the authoring skill (`skills/author/SKILL.md`) and the MCP server. Each sample ticket in `tickets/` goes to the agent in a fresh copy of `examples/`, and the harness grades what the agent left behind. Run it by hand after changing the skill, the schema or the check rules. No CI job runs it, because every attempt is one agent session.

**Run it**

1. Start the demo app: `docker compose -f examples/demo-app/docker-compose.yml up -d`. The harness stops with exit code 2 when the app on port 3300 or Mailpit on port 8325 does not answer.
2. Install Playwright's Chromium once: `pnpm --filter @bazam/driver-web exec playwright install chromium`.
3. Log the agent in. The default agent is `claude -p`, which uses your Claude account and needs a Claude Code version with `--restricted`.
4. From the repository root: `pnpm eval:drafting`.
5. `EVAL_AGENT_CMD` replaces the agent command, `EVAL_REPEATS` (default 3) sets the attempts per ticket, and `EVAL_TICKETS` names another folder of tickets, such as one with a subset of them.
6. Before any agent starts, the harness copies `examples/` once and checks that the copy passes `check` and `plan --env demo` and that it has the case of every `extend` ticket. A failure there costs no agent session.
7. The harness prints one line per attempt on stderr and the path of the result file on stdout. It exits 0 once the result file is written, whatever the grades, and 2 when the harness itself fails: the demo is down, a ticket is malformed, or a copy of `examples/` fails `check` before the agent starts (another change to `examples/` may be half done).
8. Ctrl-C, or SIGTERM or SIGHUP, stops the agent, the runs it started and the graded run, deletes the copy, and exits with 128 plus the signal number (130 for Ctrl-C). A second Ctrl-C exits at once, without that cleanup. Closing the terminal sends SIGHUP, so run a long eval in tmux or screen rather than under `nohup`.
9. When the harness fails or is stopped after some attempts, it still writes the result file with the attempts it finished.

**One attempt**

1. The harness copies `examples/` to a new folder under the system temp directory: the files git does not ignore, without `demo-app/`, plus `.bazam/secrets.env` and `fixtures/identities.local.yaml` (or `identities.example.yaml` when there is no local copy). The copy sits outside any git repository, as a fresh clone would.
2. It runs `check` and `plan --env demo` on the copy to get a clean baseline and the case ids before the agent, and records the steps and checks of every case.
3. It runs the agent once (see below), with a 15 minute limit.
4. It stops every run the agent left behind: each `runs/<id>/supervisor.json` names a process that leads its own process group, and runs started through `run_start` outlive the agent. The harness signals that group only when the process's command line names the copy, as a run the MCP server started does, since the agent can write any `supervisor.json`.
5. It refuses to load a copy with code the agent wrote. When the agent added or changed any file that Node could run, the attempt fails the check and run grades (and the ids grade for an `extend` ticket), and the harness runs no command on the copy, since `check`, `plan` and `run` import the project's plugins and hooks. Every file other than YAML, JSON, XML, Markdown, text, logs, `.env` files, images, videos and zip archives counts as code, and so does any symlink. The keys `plugins`, `runners` and `targets` of `bazam.config.yaml` count as code too, since the CLI starts the commands they name: when the agent changed any of them, or left a config the harness cannot read or parse, the attempt fails the same way before any command runs.
6. It grades the copy, then deletes it.

Attempts run one at a time, since the demo app, Mailpit and the browsers are shared.

**Agent contract**

1. The harness runs `EVAL_AGENT_CMD` through `sh -c`, with the working directory in the copy and the prompt on stdin.
2. The prompt is a fixed preamble followed by the ticket without its front matter. The preamble asks for the cases the ticket needs, names the skill and the MCP tools, says no person is available, and says the cases that link the ticket are checked and run afterwards.
3. The agent's environment adds `EVAL_TICKET_FILE` (the ticket as the agent sees it), `EVAL_SKILL_FILE` (the skill's path) and `EVAL_MCP_CONFIG`, a JSON file `{ "mcpServers": { "bazam": { "command": ..., "args": [...] } } }` that starts the MCP server from the sources with `--root` set to the copy.
4. Unset, the command is `claude -p --output-format json --restricted --tools Read,Glob,Grep,Edit,Write --permission-mode dontAsk --mcp-config "$EVAL_MCP_CONFIG" --strict-mcp-config --append-system-prompt "$(cat "$EVAL_SKILL_FILE")" --allowedTools 'mcp__bazam__*' Read Glob Grep Edit Write --no-session-persistence`.
5. In that command, `--restricted` removes Bash and the other tools that run code, skips your user, project and local settings files (with their allow rules, default permission mode and hooks), and confines the file tools to the copy. `--tools` leaves the agent five file tools besides the MCP tools, and `dontAsk` denies anything not allowed.
6. This is no sandbox. The MCP server the agent starts loads the copy's plugins and hooks, so code the agent writes into the copy can run with the environment of the agent's process. YAML can start processes too: an object `plugins` entry in the config starts its command when the MCP server loads the copy, and a runner starts when a run selects its target. The agent can also edit the suite such a runner runs. The harness never loads such a copy itself and refuses it as it refuses a hook (see above). Run the eval in a container or a VM when that matters.
7. The model id comes from the agent's JSON output on stdout: the keys of `modelUsage`, or a top-level `model`. Without either it is `unknown`.
8. When the time limit passes, the harness stops the agent's process group. Whatever is left of the group once the agent exits, such as its MCP server, is killed too.

**Grades**

1. `check`: `check` on the copy reports no errors.
2. `run`: `run --env demo --link jira:<ticket key> --channel answers-file` exits 0, and at least one case it ran is new or has steps or checks other than the baseline's. Only the cases that link the ticket run, so an agent that adds no link, changes nothing, or only adds the ticket's link to a case that already passes fails this grade.
3. `ids`: for an `extend` ticket only, `plan` lists no case id that the baseline did not have. A draft that leaves the project unloadable counts as a fail here too, since its ids are unknown. Other tickets record the ids they added without a grade.

The harness answers every person prompt in the graded run itself: pass for a verdict, done for an action and blocked for a value. The run grade of a guided ticket therefore measures that the case runs and its `observe` agrees with the answer. It does not measure a person's judgment.

**Tickets**

One Markdown file per ticket in `tickets/`. The front matter holds `key: value` lines that only the harness reads:

1. `key`: the ticket key, such as `DEMO-501`. Keys `DEMO-101` to `DEMO-401` belong to the example cases.
2. `kind`: `new` for a behavior no case covers, `extend` for one an example case already covers, `guided` for one that needs a person to act or judge.
3. `case`: for an `extend` ticket only, the id of the case it extends, which must exist in `examples/`.

Describe only behavior the demo app has (see `examples/demo-app/README.md`), so a good draft can pass against it.

**Result file**

1. `results/<timestamp>.json` holds the agent command, the model ids, the skill's git blob hash (it changes with any edit, committed or not) with the last commit to touch it, the package version of the CLI, and a pass rate per grade overall and per ticket.
2. Each attempt records the agent's exit and duration, the error rule ids from `check`, the run's counts and case statuses, the drafted cases the run selected, the prompts the harness answered, and the case ids added. The file holds no agent output and no run evidence.
3. A file written after the harness failed or was stopped names the reason in `stopped` and holds only the attempts that finished.
4. The agent command is recorded with the value of every `NAME=value` assignment in it masked. A key passed any other way, such as a flag, stays in the file, so give keys to the agent through the environment.
5. Git ignores `results/`. Keep a result with `git add -f` after reading it.

**Self-test**

`node evals/drafting/self-test.ts` checks the harness without a model. It needs the demo app running and takes about 25 seconds. It runs the eval three times, with one attempt per ticket:

1. With the default command, through a `claude` stub first on `PATH` that starts the self-test as the agent. The agent checks the command's flags and the contract above, drafts a passing guided case for `DEMO-506`, adds a case with no check for `DEMO-505` (a second id for a behavior `AUTH-SESSION-001` covers), only adds the `DEMO-502` link to `API-KEY-001`, writes a plugin for `DEMO-503`, and adds a process plugin entry to `bazam.config.yaml` for `DEMO-504`. For `DEMO-506` it also leaves a run behind with a `supervisor.json`, plus run records that name an unrelated process and an invalid pid. The self-test then asserts every grade, the model ids from `modelUsage`, that the run was stopped before grading, that the unrelated process lives on, that the plugin never loaded, that the config plugin never started, and that git ignores the result file.
2. With `EVAL_AGENT_CMD` set to a command with an inline fake key, stopped with SIGINT while the agent works on `DEMO-502`. It asserts exit code 130, that the agent and the copy are gone, and that the result file holds the `DEMO-501` attempt with the key masked.
3. With `EVAL_TICKETS` naming a folder whose `extend` ticket names a case `examples/` does not have. It asserts exit code 2 before any agent started.

It deletes each result file once its checks hold, and keeps and names the file on a failure.
