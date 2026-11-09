# Plugin protocol

A plugin can run as its own process, written in any language, and talk to bazam over its stdin and stdout with JSON-RPC 2.0. It offers resolvers, challenge kinds, secret providers, result formats, tracker clients and drivers the way an in-process plugin does. What follows is protocol version 1, with plugin API version 1.

**Configuration**

1. A process plugin is an object entry in `plugins:` of `bazam.config.yaml`. A string entry is an in-process plugin.

   ```yaml
   plugins:
     - ./plugins/local-steps.ts
     - { command: [python3, plugins/otp_hook.py], timeoutSeconds: 120 }
   ```

2. `command` (required): the program and its arguments. The host starts `command[0]` with the other items as arguments, without a shell.
3. `cwd`: the folder it runs in, relative to the project root, `.` when left out.
4. `env`: variables to set for the plugin. It inherits the host's whole environment, with these added.
5. `timeoutSeconds`: how long the host waits for each answer, 600 when left out.
6. A process plugin runs with the same trust as an in-process one: it is code the project's config names. Before the first one starts, the host registers with its redactor the value of each declared secret (`secrets.names`, each tracker's `secrets`, and each `${secret.NAME}` the identities use) that is set in the host's environment, which the plugin inherits, so those values are masked in the plugin's log lines.
7. Process plugins start in config order, after the in-process entries listed before them.

**Wire format**

1. Each message is one line of UTF-8 JSON that ends in `\n`. A JSON encoder escapes line breaks inside strings, so one line holds one message. A line over 64 MiB closes the connection, and every call waiting on it fails.
2. Every request and notification carries `"jsonrpc": "2.0"`; the host answers one without it with `-32600`. A batch (a JSON array) gets `-32600` too.
3. A request has an `id`, a number or a string, and gets exactly one answer with `result` or `error`. A notification has no `id` and gets no answer.
4. Both sides send requests. The host's ids are integers, and the host matches answers to its own requests by that number, so a plugin copies `id` into its answer unchanged. The host copies the plugin's ids the same way, so a plugin may use numbers or strings.
5. stdout carries protocol lines only. The host drops a stdout line that is not JSON and logs only how many it dropped. Write logs to stderr or send `host.log`.
6. The host's own log names methods, ids and error codes, never params or results, since they may hold secrets.

**Error codes**

1. `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error.
2. `-32001` blocked: the case ends `blocked`, with the error's message as the reason.
3. `-32002` cancelled: the answer to a request whose handler stopped after `$/cancelRequest`. The side that cancelled no longer waits for it.

**How the host reads a plugin's answer**

1. The host checks each result against the method's result shape below. A result that does not match fails the call with `plugin <name> answered <method> with a result that does not match the protocol: <path>: <issue>`.
2. `-32001` becomes a blocking error with the message.
3. `-32603` counts as the contribution's own failure, as when an in-process handler throws.
4. Any other code fails the call with `plugin <name> answered <method> with error <code>: <message>`.
5. No answer within `timeoutSeconds`: the host sends `$/cancelRequest` and fails the call with `plugin <name> did not answer <method> within N s`.
6. An exit fails every waiting call, and each later one, with `plugin <name> exited with code N` (or `signal S`).
7. For a case this means:
   1. `driver.step`: `-32001` ends the case `blocked` with the message, and `-32603` fails the case, as a step that throws does. Every failure in 1, 4, 5 and 6 ends it `blocked` with an `internal:` reason, never `fail`.
   2. `driver.launch`: any failure gives `could not launch target <target>: <message>`.
   3. `resolver.arm` and `resolver.resolve`: the resolver chain handles every error alike. A resolver that fails at `resolver.arm` gives way to the next one in the chain. After the trigger, only a person resolver may take over, and only for a kind with `fallbackAfterTrigger`. With none left, the case ends blocked with `resolver "<name>" could not arm: <message>` or `resolver "<name>" failed: <message>`.

**How the host answers a plugin's callback**

1. Params that do not match get `-32602` with the first issue.
2. A `contextId` that is unknown, already released, or belongs to a call that does not offer the method gets `-32602` `<method> is not available in this context`. "Contexts" below lists what each call offers.
3. A blocking error gets `-32001` with its message. This covers a host outside the env's `hosts`, a write refused in a production env, a missing secret, a placeholder that does not resolve, a credential the app refused, and a connection that failed.
4. Any other failure gets `-32603`.
5. An unknown method gets `-32601` `unknown method <method>`.
6. A plugin passes a `-32001` it got from a callback through unchanged as its answer to the call that made the callback, so the case ends blocked. `serveProcessPlugin` does this for every code.

**Lifecycle**

1. The host spawns the command with stdin, stdout and stderr piped, and sends `initialize`. The plugin has 30 s to answer.
2. The host reads `protocolVersion` first. Another version fails the load with `plugin <name> speaks protocol version <theirs>; this host speaks version 1`.
3. `apiVersion` must be 1, the host's plugin API version, or the load fails with `PluginApiMismatch`. A contribution name that another plugin already registered fails it with `PluginConflict`. Both rules are the ones in-process plugins follow.
4. A plugin that cannot start, exits or stays silent before it answers `initialize` fails the load. When it wrote to stderr, the message ends with its last 20 stderr lines, masked. Until the host accepts the plugin's `initialize` answer, its log lines and errors name the plugin by its command line, the items joined with spaces, such as `plugin python3 plugins/otp_hook.py exited with code 1` or `plugin python3 plugins/otp_hook.py could not start: spawn python3 ENOENT`. The version error in item 2 uses the name from the answer.
5. Each stderr line and each `host.log` line goes to the host's log as `plugin <name>: <line>`, masked. The CLI and the MCP server write that log to their stderr, and a host that loads plugins without a log drops the lines. Plugins load before a run starts, so these lines never reach `run.log`.
6. The host closes its plugins once it no longer needs them: the CLI after each command, the MCP server after each tool call. It sends `shutdown` and waits up to 5 s for the answer, ends stdin, waits 2 s for the exit, sends SIGTERM, waits 3 s and sends SIGKILL. After the exit it keeps reading stdout and stderr for at most 5 s, then closes them, so a child the plugin started cannot hold the close open.
7. A plugin exits when stdin ends.

**Contexts**

The host's objects for a call, such as a step's evidence, stay in the host. Each call that may lead to callbacks carries a fresh `contextId`, and the plugin passes it back in each `host.*` request it makes while it handles that call. The id is released when the call ends, so a callback sent after the plugin answered gets `-32602`.

1. `resolver.arm`, `resolver.resolve`: `host.secret`, `host.http`.
2. `driver.step`: `host.resolve`, `host.http`, `host.evidence.record`, `host.evidence.note`, `host.evidence.followup`, `host.evidence.attach`, `host.values.set`. There is no `host.secret`; a step reads a secret with `host.resolve` of `"${secret.NAME}"`.
3. `driver.close`: `host.evidence.record`, `host.evidence.note`, `host.evidence.followup`, `host.evidence.attach`.
4. `driver.probe`, `driver.launch`: no callbacks. The id only ties the call to its context.
5. `trackerClient.connect` and every call on a connection: `host.secret`. Each call on a connection carries its own `contextId`.
6. `host.log` needs no context.

**Methods from the host to the plugin**

| Method                      | Params                                                                         | Result                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `initialize`                | `{ protocolVersion, apiVersion, host: { name, version } }`                     | `{ protocolVersion, name, apiVersion, contributions }`                 |
| `shutdown`                  | `{}`                                                                           | `null`; the host then ends stdin                                       |
| `resolver.arm`              | `{ resolver, request: ChallengeRequest, context: ResolverCallContext }`        | `null`                                                                 |
| `resolver.resolve`          | `{ resolver, request, kind: ChallengeKindSpec, context: ResolverCallContext }` | a `ChallengeAnswer`, or `null` for no answer                           |
| `secrets.load`              | `{ provider, key }`                                                            | the value, or `null` when the provider has none                        |
| `results.parse`             | `{ format, file: { path, text } }`                                             | `ExternalTest[]`                                                       |
| `trackerClient.connect`     | `{ tracker, contextId, config }`                                               | `{ connection }`, an id the plugin picks                               |
| `trackerClient.ticket`      | `{ tracker, connection, contextId, key }`                                      | `TicketState`                                                          |
| `trackerClient.attach`      | `{ tracker, connection, contextId, key, files: AttachmentFile[] }`             | `null`                                                                 |
| `trackerClient.postComment` | `{ tracker, connection, contextId, key, comment, mentions: Mention[] }`        | `{ url }`                                                              |
| `trackerClient.editComment` | `{ tracker, connection, contextId, key, url, comment, mentions: Mention[] }`   | `{ url }`, or `null` when the comment is gone                          |
| `trackerClient.transition`  | `{ tracker, connection, contextId, key, name }`                                | `null`                                                                 |
| `trackerClient.findOpenBug` | `{ tracker, connection, contextId, project, label }`                           | the bug's key, or `null`                                               |
| `trackerClient.createBug`   | `{ tracker, connection, contextId, draft: BugDraft }`                          | `{ key, url }`                                                         |
| `driver.probe`              | `{ driver, options: LaunchCallOptions }`                                       | the capabilities this target would have, as strings                    |
| `driver.launch`             | `{ driver, options: LaunchCallOptions }`                                       | `{ session, capabilities }`, where `session` is an id the plugin picks |
| `driver.step`               | `{ session, kind, step, context: StepCallContext }`                            | `null`                                                                 |
| `driver.close`              | `{ session, ending: { status }, context: { contextId } }`                      | `null`                                                                 |

1. `initialize`: `host.name` and `host.version` name the host and its version. The plugin answers `protocolVersion: 1`, its own `name`, `apiVersion: 1` and what it offers (see "Contributions").
2. `resolver.resolve` always carries `kind`, and `resolver.arm` never does. The host calls `resolver.arm` only for a resolver whose descriptor sets `arm: true`, before the app sends the challenge.
3. `results.parse`: `file.path` is relative to the runner's working folder, and `file.text` is the file's content.
4. `trackerClient.connect`: `config` is the project's `trackers.<tracker>` entry. Its `secrets` map holds secret names; read the values with `host.secret` and this call's `contextId`.
5. `driver.step`: `step` is the step's payload as the case wrote it, already checked against the step's schema; `kind` names the step.
6. `driver.close`: `status` is `pass`, `fail`, `blocked` or `followup`.

**Methods from the plugin to the host**

| Method                   | Params                                                                       | Result                                 |
| ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------- |
| `host.resolve`           | `{ contextId, value }`                                                       | the value with its placeholders filled |
| `host.secret`            | `{ contextId, key }`                                                         | the secret's value                     |
| `host.http`              | `{ contextId, request: { method, url, headers, bodyBase64? }, as?, write? }` | `{ status, headers, body }`            |
| `host.evidence.record`   | `{ contextId, check: CheckRecord }`                                          | `null`                                 |
| `host.evidence.note`     | `{ contextId, text }`                                                        | `null`                                 |
| `host.evidence.followup` | `{ contextId, item, hint }`                                                  | `null`                                 |
| `host.evidence.attach`   | `{ contextId, label, ext, dataBase64 }`                                      | `{ name }`, the attachment's file name |
| `host.values.set`        | `{ contextId, name, value }`                                                 | `null`                                 |

1. `host.resolve` fills placeholders such as `${env.APP_URL}`, `${secret.NAME}` and `${case.<name>}` in any JSON value. The host registers a secret it fills with its redactor.
2. `host.secret` reads the secret through the env's providers and registers the value with the host's redactor.
3. `host.http` sends through the run's HTTP client:
   1. `request.url` is an absolute URL. `request.headers` is required, and `{}` is fine. A body goes as `bodyBase64`.
   2. The host sends only to hosts in the env's `hosts` and checks every redirect hop, so any other host gets `-32001`.
   3. `as: { identity, surface }` sends the request as that identity, with its credentials for the surface.
   4. In a production env, any method other than GET needs `write: true`, or the call gets `-32001` `<METHOD> needs write: true in production env <name>`.
   5. In the result, `headers` maps names to values, and `body` is the parsed JSON for a JSON content type, otherwise the text, and `null` when empty.
4. `host.evidence.attach`: `ext` is `png`, `txt` or `json`. A `zip` gets `-32602` "a process plugin cannot attach zip files, which core cannot scrub".
5. `host.values.set` saves a value that later steps read as `${case.<name>}`.

**Notifications**

1. `host.log` `{ line }`, from the plugin: the host writes `plugin <name>: <line>` to its log, masked.
2. `$/cancelRequest` `{ id }`, either way: cancels the request with that `id`. The host sends it when a call's signal aborts or its `timeoutSeconds` pass, and no longer waits for the answer. A plugin that cannot stop its work may ignore it.

**Shapes**

1. `ChallengeRequest`: `{ kind, caseId, identity, step, params }`, where `params` maps names to strings from the case's challenge step.
2. `ChallengeKindSpec`: `{ name, answer: "value" or "action", humanOnly, fallbackAfterTrigger }`.
3. `ChallengeAnswer`: `{ kind: "value", value }` for a kind whose `answer` is `value` and that is not human-only, otherwise `{ kind: "done" }`.
4. `ResolverCallContext`: `{ contextId, env, prompt: { runId, timeoutMs }, stateDir }`. `stateDir` is the project's state folder, where resolvers keep per-identity state such as virtual passkeys.
5. `StepCallContext`: `{ contextId, identity?, env, values }`. `identity` is absent when neither the step nor its flow names one; `values` maps the case's values by name.
6. `LaunchCallOptions`: `{ contextId, env, target, settings, runDir, redaction: { screenshotSelectors } }`. `settings` is the target's entry in config without `driver`.
7. `env` in all three: `{ name, production, vars, hosts, challenges, locale }`, where `hosts` is a list and `challenges` maps each kind to its resolver names.
8. `ExternalTest`: `{ title: string[], tags: string[], outcome, message?, retries, project?, durationMs?, attachments: { name, path, contentType? }[], source }`, where `outcome` is `passed`, `failed`, `errored` or `skipped`.
9. `TicketState`: `{ key, status, done, assignee?, reporter? }`.
10. `comment` and a `BugDraft`'s `description`: `{ markdown, html?, adf? }`, which core renders. A process tracker client converts them to its tracker's format itself.
11. `Mention`: `{ role, accountId }`. `AttachmentFile`: `{ name, path }`, a file on the host's disk.
12. `BugDraft`: `{ project, issueType, summary, labels, description, attachments: AttachmentFile[], relatesTo }`.
13. `CheckRecord`: `{ name, kind, expected?, observed?, ok, hint? }`, where `kind` is `ui`, `api`, `guided`, `followup` or `external`.
14. A field marked `?` may be left out. Leave it out rather than send `null`.

**Contributions**

The `contributions` object of the `initialize` answer lists what the plugin offers. Every key is optional.

1. `resolvers`: `{ name, kinds, requires, automated, arm }[]`, all five fields on each.
2. `challengeKinds`: `ChallengeKindSpec[]`.
3. `secretProviders`: `{ name }[]`.
4. `resultFormats`: `{ name }[]`.
5. `trackerClients`: `{ tracker }[]`.
6. `drivers`: `{ name, surface, steps: { kind, schema }[] }[]`, where `schema` is the step payload's JSON Schema. The host builds its validator from it, so `bazam check`, `bazam schema` and the case loader treat the step like any other. A schema the host cannot read fails the load with `plugin <name> gives step <kind> a schema that cannot be read: <message>`. A process driver has no browser objects, so its identities act through `host.http` with `as`.
7. Any other key fails the load with `plugin <name> offers <key>, which a process plugin cannot offer; load it in-process`. Tracker renderers, auth strategies, check rules, channels and steps outside a driver stay in-process, since each needs a synchronous call or browser objects that do not cross a pipe.

**Resolvers**

1. A process resolver gets no session and no channel. One with `requires` is chosen only on targets whose capabilities include them, and it still cannot reach the session.
2. A process resolver with `automated: false` must reach the person by its own means, since the run's channel stays in the host.
3. `null` from `resolver.resolve` means the resolver found no answer.
4. The value a resolver answers is registered with the run's redactor once `resolver.resolve` returns, as an in-process resolver's is. A stderr or `host.log` line written before then shows it unmasked, so a resolver never logs the code it found.

**TypeScript plugins**

`serveProcessPlugin(manifest)` from `@bazam/core/plugin` serves an in-process manifest over stdin and stdout until stdin ends, so one manifest loads either way. It is also the reference implementation of the plugin's side.

1. It refuses at start a manifest that offers steps outside a driver, auth strategies, check rules, channels or tracker renderers.
2. Step schemas cross as JSON Schema of the input. A schema JSON Schema cannot represent, such as a Date, fails the start with `step <kind> of driver <name> has a schema that JSON Schema cannot represent: <message>`. Refinements and transforms do not cross, so the served side parses each `driver.step` payload with the handler's own schema and answers `-32001` `step <kind> does not match its schema: <issues>`.
3. A resolver's context calls `host.http` and `host.secret`. Its `session` and `channel` throw "a process resolver cannot reach the run's channel or session", `prompt` holds `runId` and `timeoutMs`, `now` is the plugin's clock, and `signal` aborts on `$/cancelRequest`.
4. A step's `resolve`, `http`, `values.set` and evidence methods call the host. `identities` throws "identities are not available in a process plugin". Its `http` sends `write: true` only for a step whose payload sets `write: true`.
5. `LaunchOptions.redactor` registers every `host.secret` answer. A tracker client's `ctx.secret` calls `host.secret`, and its `ctx.log` sends `host.log`.
6. A blocking error answers `-32001`, an error answer from a callback keeps its code, and any other error answers `-32603`.

**Writing a plugin in another language**

1. Read stdin line by line and parse each line as JSON.
2. A message with `method` and `id` is a request: answer it once, with the same `id`. A message with `method` and no `id` is a notification: never answer it. A message without `method` is the host's answer to one of your requests: match it by `id`.
3. Keep reading while a handler waits. The host waits on `resolver.resolve` while the plugin's `host.http` request runs, and the answer to that request comes in on stdin. In Python, read on the main thread and run each request on its own thread.
4. Write each message as one line, flush after each, and guard stdout with a lock when threads share it.
5. Answer `initialize` with `protocolVersion: 1`, `apiVersion: 1`, the plugin's name and its contributions.
6. Answer an unknown method with `-32601`. Pass an error answer from a callback through unchanged, `-32001` above all. Answer any other failure with `-32603` and a message that holds no secret.
7. Exit when stdin ends.

**Examples**

Both examples offer `demo-otp-hook`, a resolver for `otp-email` and `otp-sms` that reads the demo app's `/test/otp` hook once at `params.url`. A 200 answer `{ "code": "<code>" }` gives the code, a 404 gives no answer, and any other status fails with a message that names only the status. `packages/core/test/plugin-examples.test.ts` runs both against a stub of the hook.

1. `examples/plugins/ts-resolver/`: `manifest.ts` holds the `definePlugin` manifest, and `plugin.ts` serves it with `serveProcessPlugin`. Listed as `./plugins/ts-resolver/manifest.ts` it loads in-process; listed as `{ command: [node, --conditions=development, plugins/ts-resolver/plugin.ts] }` it runs as a process.
2. The TypeScript example imports `@bazam/core/plugin` through the workspace link at the repository root. `--conditions=development` resolves it to `packages/core/src`, so it is needed only inside this repository. A project with `@bazam/core` installed resolves it to the built `dist` and leaves the flag out.
3. `examples/plugins/python-resolver/plugin.py`: the same resolver in Python with only the standard library, which calls `host.http` for the hook. Listed as `{ command: [python3, plugins/python-resolver/plugin.py] }`.
4. The paths are relative to `examples/`, the example project's root. `examples/bazam.config.yaml` lists neither plugin. To try one against the demo app, add its entry and name the resolver in the env's chain:

   ```yaml
   plugins:
     - { command: [python3, plugins/python-resolver/plugin.py] }
   envs:
     demo:
       challenges:
         otp-sms: [demo-otp-hook]
   ```

   A challenge step then passes the hook URL:

   ```yaml
   - challenge:
       kind: otp-sms
       fill: { id: otp-input }
       params: { url: "${env.APP_URL}/test/otp?recipient=hook-${run.id}@example.test" }
     as: newcomer
   ```
