# Plugins

An in-process plugin is a TypeScript module listed in `plugins:` of `bazam.config.yaml`, such as `./plugins/page-step/manifest.ts`. Its default export is a manifest made with `definePlugin` from `@bazam/core/plugin`. [plugin-protocol.md](plugin-protocol.md) covers plugins that run as their own process. This page covers plugin steps, the browser page they can drive, and plan checks.

**Plugin steps**

1. `steps` in the manifest adds step kinds. Each has a `kind`, a zod `schema` for the step's value and a `run(step, ctx)` function.
2. `ctx.identity` is the identity the step runs as, `ctx.values` holds what `${case.<name>}` reads, and a step saves a value for later steps with `ctx.values.set(name, value)`.
3. `ctx.http` and `ctx.resolve` send requests and fill placeholders under the same host allowlist as the built-in steps. They do not check production writes. A plugin step that writes calls `assertProdWrite(ctx.env, method, { write })` from `@bazam/core/env` before it sends.

**Reading the page**

1. Import `pageFor` from `@bazam/driver-web` and call `await pageFor(ctx)` in the handler. It returns the Playwright `Page` of the step's identity, or of the case's anonymous context when the step names none.
2. Set `opensBrowser: true` on the handler. The run then plans the step's web login, opens the identity's browser context and applies its credential before the step runs, as it does for a built-in web step.
3. A handler that calls `pageFor` as an identity without `opensBrowser` ends the case blocked with an `internal:` reason.
4. The page keeps the context's host allowlist, its 401 recovery and its trace, so a step sees the same session as the web steps around it.
5. `pageFor` needs the `playwright` driver. On another driver, or in a process plugin, it throws a `CaseBlocked` that says so, and the case ends blocked.
6. `pageFor` returns Playwright's `Page`. A plugin that names the type imports it from `playwright`, the peer dependency of `@bazam/driver-web`. `@bazam/core` has no Playwright types.

**Blocking a case**

1. Throw `CaseBlocked` from `@bazam/core/run` when the step cannot run because of the setup and not because the app misbehaved. The case ends `blocked` with the error message as the reason.
2. Errors from `ctx.http` and `ctx.resolve` that point at the setup (a host outside `hosts`, a missing secret, a refused credential, no answer) block the case too. Any other error fails the case, as in a built-in step.

**Plan checks**

A plan check looks at the whole selection once and blocks the cases it affects, such as cases that together plan more spend than an account holds.

1. `planChecks` in the manifest adds checks, each `{ name, check(input) }`. `bazam run` calls each one once, after preflight and before the first case, in the order the plugins loaded. `bazam plan` calls none.
2. `input.env` is the run's env. `input.cases` holds the plan's unblocked cases, each as `{ caseId, target, identities, spec }`, where `spec` is the loaded case. A case that an earlier check or a failed login blocked is left out.
3. `input.http.send(request, as?)` sends through the run's HTTP client under the env's host allowlist. `request` is `{ method, url: URL, headers: Headers, body?, redirect? }`. `as` is `{ identity, surface }`, such as `{ identity: "ops", surface: "api" }`; the call carries that identity's credential for the surface, and none when `as` is left out. `input.secret(key)` reads a secret.
4. A check returns an object of reasons by case id, such as `{ "DEMO-PAY-001": "balance 5 is under the 9 planned" }`, and `{}` blocks nothing. Each named case ends `blocked` with its reason, masked by the run's redactor.
5. A case id the check was not given is ignored, and the run log says so.
6. When a check throws, every case it was given is blocked with `internal: plan check <name> failed: <message>`, since running them could overspend.
7. In a production env `input.http` sends `GET` and `HEAD` only; any other method throws `ProdWriteRefused`.
8. Plan checks are in-process only. A process plugin that offers `planChecks` fails to load.

**Example**

1. `examples/plugins/page-step/manifest.ts` adds `page-text`, which reads the text of one element and saves it. `packages/driver-web/test/page.test.ts` loads it and runs it against a page.
2. `examples/bazam.config.yaml` does not list it: its imports resolve only inside this repository, through the root `package.json`, and the example project has to load from a copy outside it. A project of its own installs `@bazam/core`, `@bazam/driver-web` and `zod` instead.
3. To try it against the demo app, add the entry and a step to a case:

   ```yaml
   plugins:
     - ./plugins/page-step/manifest.ts
   ```

   ```yaml
   - page-text: { id: full-saved, save: saved }
     as: customer
   ```

4. `examples/plugins/plan-check/manifest.ts` adds the plan check `hold-tag`, which blocks every selected case tagged `hold` and sends no request. `packages/core/test/plan-check-example.test.ts` loads it and shows the block. `examples/bazam.config.yaml` does not list it either, for the same reason, so the example run itself does not block a case. List `./plugins/plan-check/manifest.ts` in `plugins:` and tag a case `hold` to see it.
