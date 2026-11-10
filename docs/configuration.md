# Configuration

`bazam.config.yaml` takes the keys below for envs, identities, external runners, process plugins, posting to a tracker, bugs and promotion, each with its default. `redaction.screenshotSelectors` also changes what traces record. `bazam check` reports a key that does not fit with its file and line. The messages quoted here are the ones bazam prints; the Jira ones come when a command connects to Jira.

**Envs**

`envs.<name>` holds `production`, `vars`, `hosts`, `challenges`, `locale` (a BCP 47 tag, `en` when left out) and `probes`. `probes` is `[]` when left out. Each probe is a request that `bazam run` sends once before any login and any case, to tell whether a host is reachable, such as one that needs a VPN.

```yaml
envs:
  uat:
    production: false
    hosts: [core.example.test]
    probes:
      - request: GET https://core.example.test/health
        hint: connect the VPN
```

1. `request` (required): `GET` or `HEAD`, then a URL whose host is in `hosts`. A probe sends no credentials, follows no redirect and waits 5 seconds.
2. `status`: the status that counts as reachable, any 2xx when left out.
3. `hint` (required): what the person does about it, such as `connect the VPN`.
4. A probe that gets no answer, times out or answers another status blocks every case that names a URL on that host in its steps, checks, finally steps, flows or identities' auth settings. The reason reads `GET https://core.example.test/health failed: <what happened>; connect the VPN`. A case that meets a connection failure to that host later in the run gets the hint added to its reason.
5. `bazam plan` sends no probe. `bazam check` reports a probe whose host is not in `hosts` and a method other than `GET` or `HEAD`.

**Identities**

`identities.<name>.auth.<surface>` sets a strategy and its `with:` settings. The session-cookie strategy takes a `probe` and a `refresh` request, and the `hmac` strategy takes a `probe`. Their values take `${env.…}`, `${secret.…}` and `${identity.…}` placeholders.

```yaml
identities:
  ops:
    fixture: ops
    auth:
      web:
        strategy: session-cookie
        with:
          login: { url: "${env.APP_URL}/test/login?email=${identity.ops.email}", until: { cookie: session } }
          probe:
            request: GET ${env.API_URL}/me
            body: { user_id: "${identity.ops.userId}" }
          refresh:
            request: POST ${env.API_URL}/auth/refresh
            headers:
              origin: ${env.APP_URL}
              x-csrf-token: { cookie: csrf }
```

1. `probe.status`: the status that counts as logged in, any 2xx when left out. The probe follows no redirect.
2. `probe.body`: values by dot path in the response body, compared as the `api` check compares them, so a number matches its text. The probe passes only when the status rule holds and every path has its value. A cached credential that fails is logged in again. A new credential that fails blocks the identity's cases with a reason such as `the new session-cookie credential for ops/web belongs to another account: body.user_id does not match`. The reason names paths and never values.
3. `probe.headers` and `refresh.headers` (session-cookie only): headers sent with that request in a run, in preflight and in `bazam keepalive`. A string value is sent as written. `{ cookie: <name> }` sends the value of the cached cookie of that name that a browser would send to the request's URL. When no such cookie is cached, the request fails with `the session-cookie refresh of ops needs cookie csrf for header x-csrf-token, which the cached state does not send to https://api.example.test`. A header named `cookie` is refused, since the strategy sets it from the cached state.
4. bazam writes no header value to any log.

**Runners**

`runners.<name>`, `{}` when left out. Each runner is an external suite that runner targets start; [external-runners.md](external-runners.md) covers what a run does with it.

1. `command` (required): the argv, run without a shell.
2. `cwd`: relative to the project root, `.` when left out.
3. `results` (required): a glob relative to `cwd`.
4. `format` (required): `junit`, `playwright-json`, or a format a plugin registers.
5. `mapping`: a mapping file of test titles to case ids, relative to the project root.
6. `env`: `{}` when left out. Values take `${env.NAME}`, `${secret.NAME}` and `${run.…}` placeholders: `${run.id}`, `${run.time}` and `${run.random(min, max, decimals)}`.
7. `timeoutMinutes`: 60 when left out, 35791 (about 24.8 days) at most, the longest timer Node can set.
8. `prodSafe`: `false` when left out. Without it, a run in an env with `production: true` asks before it starts the runner.
9. `identities`: every identity in the config when left out. A runner that names an unknown one gets `runner <name> lists identity <id>, which is not defined under identities`.

A runner name takes letters, digits, dots, dashes and underscores, starting with a letter or digit.

**Targets**

`targets.<name>`, `{}` when left out.

1. A driver target sets `driver` and the driver's own settings, such as `browser`.
2. A runner target sets `runner`, the name of an entry in `runners`, and `env`, `{}` when left out, which adds to the runner's `env`. It takes no other key.
3. The messages: `a target needs driver or runner`, `a target names a driver or a runner, not both`, `runner <name> is not defined under runners` and `a runner target's name takes letters, digits, dots, dashes and underscores, starting with a letter or digit`.

**Plugins**

`plugins`, `[]` when left out. A string entry is the path of an in-process plugin module, which [plugins.md](plugins.md) describes. An object entry is a process plugin, which [plugin-protocol.md](plugin-protocol.md) describes:

```yaml
plugins:
  - ./plugins/local-steps.ts
  - { command: [python3, plugins/otp_hook.py], timeoutSeconds: 120 }
```

1. `command` (required): the argv, run without a shell.
2. `cwd`: relative to the project root, `.` when left out.
3. `env`: added to the plugin's environment, `{}` when left out.
4. `timeoutSeconds`: how long the host waits for each answer, a whole number, 600 when left out and at most 2147483 (about 24 days), the longest delay a Node timer holds.
5. Any other entry gets `a plugin entry is a module path, or an object whose command is an argv list such as [python3, plugins/otp_hook.py]`.

**Trackers**

`trackers.<tracker>`, `{}` when left out. `site`, `api` and `secrets` let `bazam report post` and `bazam promote --from-tracker` reach the tracker themselves; an agent that posts the post plan needs only `projects`.

```yaml
trackers:
  jira:
    site: example.atlassian.net
    # api: https://api.atlassian.com/ex/jira/<cloudId>
    secrets: { email: JIRA_EMAIL, token: JIRA_API_TOKEN }
    projects:
      DEMO:
        transitions: { pass: Done, fail: In Progress }
        bugs: { issueType: Bug, labels: [regression], onPass: Done }
        promoteOn: [Done, Released]
```

1. `site`: the tracker's host and an optional port, which browse links use; https is implied. Only a `127.0.0.1` or `localhost` site with a port is reached over http, which tests use. Any other form gets `site takes a lowercase host and an optional port other than 443, such as example.atlassian.net, with no scheme, credentials, path, query or fragment`. `report post` refuses to start without it: `cannot post to <tracker>: trackers.<tracker>.site is not set`.
2. `api`: the REST base when it is not `https://<site>`, such as a scoped API token's. Browse links still use `site`. A base that is not https gets `api must be an https URL; http only for 127.0.0.1 or localhost with a port`. Jira takes only the scoped form: `trackers.jira.api must be https://api.atlassian.com/ex/jira/<cloudId>; http only for 127.0.0.1 or localhost with a port`.
3. `secrets`: `{}` when left out. Each key is a role and each value a secret name, read through `secrets.providers`. Jira reads the roles `email` and `token`; a missing one gets `trackers.jira.secrets.email is not set` or `trackers.jira.secrets.token is not set`. bazam masks their values in everything it writes, and no runner gets the variables that hold them.
4. `projects.<project>`: `{}` when left out. The key is the project part of a ticket key, such as `DEMO` for `DEMO-12`. Jira takes capital letters, digits and underscores, starting with a letter: `trackers.jira.projects lists <project>, which is not a Jira project key: capital letters, digits and underscores, starting with a letter`.

**Tracker projects**

Each key of `trackers.<tracker>.projects.<project>` is optional, so a project listed only for bugs or promotion needs no transitions.

1. `transitions`: `{}` when left out. The transition a post applies to the ticket, by result status: `pass`, `fail`, `blocked` or `followup`.
2. `bugs`: without it, bazam files no bugs in the project. When `report post` posts a run, a regression case that fails files a bug in the project of its first linked ticket whose project sets `bugs`, or comments on that case's open bug. A regression case that passes comments on its open bug and applies `onPass`. Blocked and follow-up results file nothing.
   1. `issueType` (required): the issue type of a new bug, such as `Bug`.
   2. `labels`: `[]` when left out. bazam adds `bazam-<case id>` to them, the label it searches for to find the case's open bug.
   3. `onPass`: a transition for the open bug once its case passes. None when left out.
   4. `linkType`: `Relates` when left out. The type of the link from a new bug to each ticket the case links to in a listed project of the same tracker.
3. `promoteOn`: `[]` when left out. `bazam promote --from-tracker` moves an acceptance case to regression when every ticket it links to is in one of these statuses, compared without case, and its latest result in the env passed. An empty list keeps every case in acceptance, with the reason `<key> is <status>; trackers.<tracker>.projects.<project>.promoteOn lists no status`. A ticket of a project missing from `projects` gives `project <project> is not listed under trackers.<tracker>.projects`.

**Redaction**

`redaction` adds to the built-in masking rules.

1. `patterns`: `[]` when left out. Regular expressions, read with the u flag; every match is masked whole.
2. `screenshotSelectors`: `[]` when left out. Playwright selectors, such as CSS, of the page elements masked in screenshots. Any entry also turns off DOM snapshots and network entries in traces, which these selectors cannot mask. Such a trace keeps actions, console messages and page errors.
