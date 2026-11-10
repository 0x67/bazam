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

`refreshEveryMs` sits beside `strategy` and `with` on a surface and keeps a credential fresh through a long case.

```yaml
identities:
  ops:
    auth:
      web:
        strategy: session-cookie
        with:
          login: { url: "${env.APP_URL}/test/login?email=${identity.ops.email}", until: { cookie: session } }
          refresh: { request: "POST ${env.API_URL}/auth/refresh" }
        refreshEveryMs: 120000
```

5. From the end of preflight until the last case that acts as the identity ends, `bazam run` refreshes the credential every `refreshEveryMs` milliseconds, under the lock `bazam keepalive` takes. A credential that another process saved under the lock is adopted instead of refreshed again. The wait starts after the last refresh ends.
6. A running case that acts as the identity loads the refreshed credential into its browser contexts before its next step starts. A step in progress is not interrupted.
7. A refresh that fails adds the note `refreshing ops's web credential on its interval failed: <reason>` to each running case that acts as the identity, and the run goes on.
8. `bazam check` reports `refreshEveryMs` below 10000, on a strategy that has no refresh, and on a session-cookie surface without a `refresh` request. A surface that uses `from:` takes no `refreshEveryMs`, so the config schema refuses it. Set it on the surface that owns the credential.

`lostOn` sits beside `strategy` and `with` on a `with:` surface and names the page that a lost session redirects to. It is for an app that answers a page load or a form post with a redirect to its login page, while only some calls answer 401.

```yaml
identities:
  ops:
    auth:
      web:
        strategy: session-cookie
        with:
          login: { url: "${env.APP_URL}/test/login?email=${identity.ops.email}", until: { cookie: session } }
        lostOn: { url: "${env.APP_URL}/login*" }
```

9. `url` (required): a URL pattern in which `*` matches any text, as in `expect: { url }`. It takes `${env.…}` placeholders.
10. A surface that uses `from:` takes no `lostOn`, so the config schema refuses it. Set it on the surface that owns the credential. A surface that reuses it reads that surface's `lostOn`.
11. `lostOn` only takes effect on a driver whose browser reports a lost session, as the `playwright` driver does. A process plugin's driver does not.

**Logging in again after a 401 or a lost session**

A 401 reaches the run from a browser context or from the run's HTTP client. The two recover differently.

A 401 in a browser context, when the identity's credential then fails its probe, is recovered once per case.

1. A strategy that can refresh refreshes the credential and adds the note `refreshed ops's web credential after a 401 from https://app.example.test`. A refresh that fails also falls back to a new login, and the note then reads `logged in again as ops on web after a 401 from https://app.example.test`.
2. A strategy that cannot refresh logs in again before the case's next step, under the refresh lock, with its flow and its person prompt through the run's channel. A credential that another process saved under the lock is adopted instead, and the note reads `refreshed ops's web credential after a 401 from https://app.example.test`. When a new login ran, the note reads `logged in again as ops on web after a 401 from https://app.example.test`.
3. The new credential is cached and loaded into the identity's open browser contexts.
4. A login that fails or times out blocks the case with `logging in again as ops on web after a 401 from https://app.example.test failed: <reason>`.
5. A strategy that caches nothing, such as `api-key`, cannot recover. The case notes `got a 401 from https://app.example.test; the web credential of ops cannot be refreshed`.
6. The new login counts as the case's one recovery. A later 401 in the same case adds the note `another 401 from https://app.example.test after this case's one recovery`, once, and nothing more.

A redirect to the page `lostOn` names counts as a 401 from that page's origin, in a browser context of the identity. A navigation that starts at a matching URL, such as opening the login page itself, is left alone.

1. The recovery is the one above, and its notes name the redirect: `logged in again as ops on web after a redirect to https://app.example.test/login`, or `refreshed ops's web credential after a redirect to https://app.example.test/login`. The query is left out, since a login page's `next=` parameter can hold anything.
2. A later redirect in the same case adds the note `another redirect to https://app.example.test/login after this case's one recovery`, once. The recovery is shared with the 401 one: a case recovers once in all.
3. The web `open` step throws `SessionLost` when its navigation ends at a matching URL. A step that throws `SessionLost` waits for the recovery the redirect started, or starts one, and runs again when the recovery succeeds. The case notes `step 3 (open) ran again after logging in again as ops on web`, or `after refreshing ops's web credential`.
4. A step that throws `SessionLost` a second time blocks the case with `step 3 (open) landed on the login page again after the session was recovered`. One that throws it after the case's one recovery was spent blocks it with `step 3 (open) lost the web session of ops again after this case's one recovery`.
5. A step that throws `SessionLost` blocks the case when it acts as no identity or as one with no auth for the driver's surface (`step 3 (open) landed on the login page, but it acts as no identity with web auth`), when the credential still passes its probe (`step 3 (open) landed on the login page, but the web credential of ops still passes its probe`), and when it cannot be refreshed or logged in again (`step 3 (open) landed on the login page, and the web credential of ops cannot be refreshed or logged in again`). A login that fails blocks it with the login's reason.
6. A finally step recovers the same way. A step that still fails becomes a note.
7. A form post that the redirect lost is not sent again.

A 401 to the run's HTTP client probes the credential first, and leaves one that still passes alone. When the probe fails, each request recovers through the same refresh, adoption or login as above, and the request is sent once more with the new credential.

1. A refresh adds no note. A new login adds the note `logged in again as ops on web after an HTTP 401`.
2. A failed recovery blocks the case with `no web credential for ops: <reason>`.

`bazam keepalive` refreshes a credential and never logs in.

**Roles**

`roles.<name>` lets a run choose which identity plays a part in a case, so two testers run the same cases as themselves. They are called identity roles here; `people.yaml` has its own roles, which mentions use (`role:qa-lead`) and which are unrelated.

```yaml
roles:
  tester: { identities: [alice, bob], default: alice }
```

A case then writes `as: tester` and `${identity.tester.email}`.

1. `identities` (required): the identities that may play the role, at least one, each defined under `identities`.
2. `default`: the identity that plays the role when the run names none. It must be one of `identities`.
3. `roles` is `{}` when left out. A role name takes lowercase letters, digits and dashes, starting with a letter, and may not be the name of an identity.
4. `bazam run` and `bazam plan` take `--as <role>=<identity>`, once per role. Before planning, bazam replaces the role with that identity in every `as:` and every `${identity.<role>.…}` placeholder of the selected cases and of the flows they use. The identity's own fixture, cached credential, logins, locks and result then apply, so switching between `alice` and `bob` logs nobody in again. A role reaches a flow through the `use:` step's `as:` or an `${identity.<role>.…}` placeholder; a role name given as a flow parameter value is not replaced.
5. A case that names a role with no binding is blocked with `role tester plays no identity in this run; pass --as tester=<identity>, one of alice, bob`.
6. `--as` is refused for a role that is not defined (`unknown role "qa"; roles: tester`), for an identity the role does not list (`role tester lists alice, bob, not ops`) and for the same role twice (`--as names role tester twice`). A value without `=` gets `--as on run and plan takes <role>=<identity>, such as tester=alice, not "tester"` (the value you passed shows after `not`).
7. `bazam plan` prints `roles: tester=alice` for each role bound in the run, by `--as` or by its default, and nothing when no role is bound; its JSON holds the bindings as `roles`. The MCP tools `run_plan` and `run_start` take them as `roles`, an object of role to identity.
8. `bazam keepalive` and `bazam logout` take one identity name in `--as`, never a role, and refuse more than one `--as`.
9. `bazam check` refuses a role named like an identity, a role that lists an unknown identity and a default the role does not list. It reads `${identity.<role>.<field>}` from the fixture of each identity the role lists.

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

1. A driver target sets `driver` and the driver's own settings, such as `browser`. The `playwright` driver takes the settings in item 4.
2. A runner target sets `runner`, the name of an entry in `runners`, and `env`, `{}` when left out, which adds to the runner's `env`. It takes no other key.
3. The messages: `a target needs driver or runner`, `a target names a driver or a runner, not both`, `runner <name> is not defined under runners` and `a runner target's name takes letters, digits, dots, dashes and underscores, starting with a letter or digit`.
4. The `playwright` driver's settings, all optional:
   1. `browser`: `chromium`, `firefox` or `webkit`, `chromium` when left out.
   2. `channel`: `chrome` or `msedge`, the installed browser to launch. It needs `browser: chromium`.
   3. `headless`: `true` when left out.
   4. `testIdAttribute`: the attribute that `{ id: ... }` selectors read, `data-testid` when left out.
   5. `permissions`: the browser permissions that every context of a case and the login tab grant, such as `[geolocation]`. None are granted when left out, so a page that asks for another one, such as the camera, is refused. On Chromium the driver also grants `local-network-access` itself when it sets extra headers, with or without this list.
   6. `args`: extra browser launch arguments, `[]` when left out. Targets that differ in `args` launch separate browsers, and targets that match share one.
   7. `viewport`: the page size in CSS pixels, such as `{ width: 1600, height: 1000 }`, for every context of a case and the login tab, so screenshots and traces show that size. Playwright's 1280x720 applies when left out. Width and height are positive whole numbers.
5. A setting that does not fit fails the plan with `target <name>:` and the problem, before any browser launches.

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
3. `result.json` keeps what steps saved as `caseValues`, masked by the run's redactor with the rest of the result, so a value matching a rule, such as 8 or more digits, appears masked. `patterns` only add masking and cannot unmask it, and `values` stays unmasked. See item 6 of [plugins.md](plugins.md).
4. `shown`: `[]` when left out. Fixture field names, such as `email`, that a `fill` step leaves unregistered and that `bazam scan` leaves out. The built-in rules still apply to their values: the part before `@` of an address outside `example.*`, and runs of 8 or more digits are still masked. A plugin step's `ctx.mask` still registers one. See items 7 and 8 of [plugins.md](plugins.md).

**Scanning evidence**

`bazam scan --run <id>` looks through the files of a run for values that must not be there. It reads every file under `runs/<id>/` except png and jpeg images, and the text entries of each zip, such as a trace, nested zips included. A screenshot is never scanned; `redaction.screenshotSelectors` masks page elements in them.

1. It looks for the value of each field of the local fixtures file, in each phone form (a number written `+447700900123` is also looked for as `7700900123` and `07700900123`), except the fields `redaction.shown` lists; the value of each declared secret it can read; the secret values of the credentials cached for the run's env; an email address outside the `example.*` domains; and a run of 8 or more digits that is not part of a run id, an epoch time in seconds or milliseconds, or a YYYYMMDD date, within 7 days of the run's start.
2. Each value is matched as written, JSON-escaped, percent-encoded, form-encoded and base64.
3. A finding has a kind: `fixture alice.phone`, `secret DEMO_PIN`, `credential ops/web`, `email` or `digits`. A file is named relative to the run folder, and a zip entry as `<file>:<entry>`, such as `DEMO-001/trace.zip:trace.trace`.
4. The output has one line per file and kind, `<file>: <kind> x<count>: "<context>", ...`, with up to three contexts of up to 30 characters on each side. A fixture, secret or credential value in a context shows as `[<kind>]`, and a digit run as `<n digits, ends 1234>`. No value is printed. Then comes `<n> files, <n> findings` and one `skipped <what>` line for each secret that no provider holds, credential whose values bazam cannot tell and zip it cannot read. `--json` prints the whole report.
5. Exit codes: 0 with no finding, 1 with any, 2 when `--run` is missing or not a plain file name, the run has no case results, its env is gone from the config, or the config does not load.
6. A trace holds the digits of the app's own data, so a scan can exit 1 on `digits` alone. Read the few lines it prints before you act. A scan reads every declared secret through the providers, which can ask `op` for a secret the run never used.

A post plan leaves out each attachment that holds a fixture, secret or credential value, whatever the run, `bazam report plan`, `bazam report post` or the MCP tool `report_plan` built it. A `digits` or `email` finding does not withhold one.

1. The plan item lists each such attachment under `withheld`, as `{ attachment, kinds }`, and its comment never names it. `withheld` is left out when nothing is withheld.
2. A run, `bazam report plan` and `bazam report post` write `post plan withholds <caseId>/<file>: <kinds>` for each one, to the run log or the terminal. `report_plan` returns `withheld` in its document.
3. If the attachment scan throws, the run logs `scanning the attachments failed: <message>` and keeps every attachment in the plan.

**Doctor**

`bazam doctor --env <env>` reports whether the local secrets, fixtures and credentials are ready for the env's cases, and never prints a value.

1. **Secrets**: one line for each declared secret, `<NAME>: held by <provider>` or `<NAME>: no provider holds it`. A provider that fails, such as `op` that cannot read, gets one line, `provider <name> failed: <message>`, and counts as a problem.
2. **Local files**: `<stateDir>/secrets.env` as `absent`, `present, mode 0600` or `present, mode 0644, readable by others`. The mode is checked on POSIX only.
3. **Identities**: the identities that the cases able to run in the env name, through `as:`, a placeholder or a role, which expands to the identities it lists. In a production env only `prod_safe` cases count. Each identity gets its fixture entry, then a line for each field judged by its name:
   1. A field named `phone`, or ending in `phone` in any case, must parse as a phone number: `alice.phone: phone, country United Kingdom`.
   2. A field named `email`, or ending in `email`, must look like an address: `alice.email: email, example domain` or `email, not on an example domain` in any case.
   3. A field named `password`, `pin` or `passcode` shows its length only: `alice.pin: 4 characters`.
   4. Any other field has no line.
4. Each surface of those identities gets `<identity>/<surface>: credential <state>`, where the state is `cached`, `refresh`, `scripted`, `person` or `static`. Doctor reads the cache and never probes or logs in.
5. Besides the lines above, a problem line is `<identity>: not in identities`, `<identity>: no fixture entry <entry>`, `<identity>.<field>: not a phone number`, `<identity>.<field>: not an email address` or `<identity>/<surface>: credential state unknown: <message>`. Each gets a line `fix: ...` under it: `set <NAME> in <stateDir>/secrets.env or the environment`, `add a 1Password reference under secrets.refs, or set <NAME> ...` when `1password` is a provider, `chmod 600 <path>`, `check the <name> provider's setup, then run doctor again`, `add <identity> under identities in bazam.config.yaml`, `add <entry> to fixtures/identities.local.yaml`, `fix identities.<identity>.auth.<surface> in bazam.config.yaml`, `write <identity>.<field> as +<country code><number>`, `write <identity>.<field> as name@example.test` and `use an example.test address for <identity>.<field>`.
6. The output ends with the count, such as `2 problems` or `1 problem`. Exit codes: 0 with no problem, 1 with any, 2 when `--env` is missing or unknown, or the config does not load. `--json` prints the report.
