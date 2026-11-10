# Plugins

An in-process plugin is a TypeScript module listed in `plugins:` of `bazam.config.yaml`, such as `./plugins/page-step/manifest.ts`. Its default export is a manifest made with `definePlugin` from `@bazam/core/plugin`. [plugin-protocol.md](plugin-protocol.md) covers plugins that run as their own process. This page covers steps that need the browser.

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

**Example**

`examples/plugins/page-step/manifest.ts` adds `page-text`, which reads the text of one element and saves it. `PROFILE-PHONE-002` in `examples/cases/profile/phone-restore.yaml` uses it:

```yaml
- page-text: { id: full-saved, save: armed }
  as: customer
```
