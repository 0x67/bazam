---
name: bazam-author
description: Drafts and edits test cases from a ticket. Finds an existing case first, picks the domain and stage, writes checks that observe outcomes, decides when a person must act, and uses placeholders for every URL, credential and personal value. Then checks, plans, runs and reports through the MCP tools. Use when asked to write, extend, run or report a case.
---

# Authoring cases

This skill holds the judgment calls. `bazam check` enforces the mechanical rules and the `case_check` tool runs the same rules; each section below names the rule ids it relies on, so read a rule's message and fix in the check output instead of guessing them. The example project in `examples/` runs every step kind, auth strategy and challenge resolver against the demo app, and the case ids named here point into it.

**1. Read the ticket**

1. Read the summary, the description and the acceptance criteria. Each criterion is a behavior that a case shows passing or failing.
2. Note the ticket key. It becomes the case link, such as `links: [jira:TD-246]`.
3. For each criterion, write down who acts (the identity), where (a page or an endpoint), what makes the behavior happen, and which outcome proves it.
4. When the ticket leaves an outcome open, ask the person. Never invent an expected value.

**2. Find an existing case first**

1. Search with `cases_search` for the behavior, the ticket key, and the pages or endpoints the ticket names.
2. When a case already covers the behavior, extend it: add the ticket to its `links`, add the missing checks, and keep its id. A second id for the same behavior splits its history across two cases.
3. Add a new case only for a behavior no case covers. Put it in the file of the journey it belongs to; one file holds one journey and may hold several cases.
4. Ids in `cases/.retired` are never used again (`id-retired`), and no two cases share an id (`id-unique`).

**3. Choose the domain, id and stage**

1. The domain is the folder under `cases/`, such as `cases/auth/`. Pick the folder of the product area the behavior belongs to.
2. The id is the folder name in upper case, a short area and the next free number in that area, such as `AUTH-PIN-001` in `cases/auth/` (`id-format`, `id-domain`).
3. A case drafted from a ticket takes `stage: acceptance` and the ticket link (`stage-link`). An acceptance case posts every result to its tickets.
4. Use `stage: draft` while a case is still taking shape. It runs and posts nothing.
5. Leave `stage: regression` to `case_promote`, which moves an acceptance case there once it has passed in the named environment.
6. Set `risk` from the ticket's impact. Set `once: true` for a case that must run a single time, such as a data migration check; it needs a link and is never promoted.
7. `targets` lists where the case may run. A run uses the first one unless the person picks another.
8. Set `prod_safe: true` only when every step is safe against production data, and mark each non-GET `request` in that case `write: true` (`prod-safe`). A production run refuses any other write, as `OPS-PROD-001` shows on env `demo-prod`.

**4. Write the steps**

1. Name the identity on every step of a journey with `as:`. Each identity acts in its own browser context and steps that name none run in an anonymous one, so a single missing `as:` moves that step to another browser. A `use:` step's `as:` covers the flow steps that name no identity.
2. A `challenge` step always needs an identity, or the plan blocks the case.
3. `request` and `api` steps send with the identity's `api` credential. The identity needs an `api` auth in the config.
4. Select elements by test id, `{ id: <data-testid> }`, or by role, `{ role: button, name: Save }` (`selector-test-id`). When the app has no test id for an element, ask for one on the ticket before falling back to text or CSS.
5. Reuse a flow from `flows/` for steps several cases share, such as signing in: `use: { flow: email-sign-in, with: { email: ... } }` (`flow-expands`). Write a new flow once a second case needs the same steps.
6. For a code or confirmation the app asks for (email or SMS code, TOTP, PIN, passkey), write a `challenge` step with its `kind`, the `trigger` step that makes the app ask, and the `fill` field for a code. The environment's resolver chain answers it, so the case never holds the code. Submit the form in the next step.
7. A `pin` challenge names the secret that holds the PIN in `params.secret`, and config must declare it (`pin-secret-declared`). `AUTH-PIN-001` shows one.
8. Use `note:` for context a reader of the evidence needs, such as why a step stands in for something the app does not have.

**5. Write checks that observe outcomes**

1. Every case needs a check: a `checks` entry, an `expect` step, or a guided step with `expected` (`case-has-check`).
2. Check the outcome the ticket promises: the confirmation shown, the value saved, the state an endpoint reports. A tap that went through proves nothing on its own.
3. When the page shows a value, prefer `expect: { text: { field: ..., equals: ... } }` to `visible`. Use `expect: { url: <glob> }` for where a page ends up.
4. Back a page outcome with an `api` check when an endpoint exposes the same state, such as `api: { request: "GET ${env.APP_URL}/api/session/me", as: customer, status: 200, body: { email: ... } }`.
5. To carry a value from one response to a later step, use `request` with `save:` and read it back as `${case.<name>}`, as `API-HMAC-001` does.

**6. Decide when a step must be guided**

1. Write a `guided` step only when a person has to act or judge: a face scan, a physical device, how a page looks. Anything a driver can do stays automated.
2. Give the person numbered `steps` they can follow without the ticket, and an `expected` line they can confirm or reject.
3. Add `observe` when the system can confirm what the person reports, usually an `api` check. A pass that the observation contradicts fails the case.
4. Take a `screenshot` right before the guided step. The prompt shows the latest one.
5. Write a face or biometric step as a `challenge` with that kind; the environment's chain sends it to a person. A kind listed under `challenges.humanOnly` may only go to a person (`human-only-chain`).
6. `AUTH-FACE-001` shows a face challenge, a guided step and its `observe` together.

**7. Use placeholders instead of literals**

1. Keep URLs, credentials, tokens and personal data out of case files. `placeholder-resolves`, `no-literal-secret` and `fixture-domain` catch most slips.
2. `${env.NAME}` holds base URLs and other values that differ per environment. Every environment defines the name.
3. `${secret.NAME}` holds credentials and PINs. Declare the name under `secrets.names`.
4. `${identity.<name>.<field>}` reads a person's data from the fixtures file through the identity's `fixture`. A phone field also gives its forms, such as `.e164`, `.national`, `.region` or `.countryCode` (see `PROFILE-PHONE-001`).
5. `${run.id}`, `${run.time}` and `${run.random(min, max, decimals)}` differ per run, such as a new address `user-${run.id}@example.test` for a sign-up. The result records them, and the run's seed replays the random ones.
6. `${case.<name>}` reads what a `request` step saved, plus `${case.id}` and `${case.title}`.
7. `${param.<name>}` works only inside a flow, for the values its `use:` step passes.
8. New fixture data goes in `fixtures/identities.example.yaml`, with addresses under `example.test` and phone numbers from fictional ranges such as `+44 7700 900123`.
9. End a line with `# bazam: allow-secret` only when it holds no secret and `no-literal-secret` flags it anyway.

**8. Word the evidence**

1. Write the title as the behavior in the ticket reader's words, such as "Customer confirms a transfer with their PIN". Leave step lists and ids out of it.
2. Name a screenshot after what it shows, such as `dashboard` or `transfer-confirmed`.
3. Write guided steps and `expected` for someone who has never seen the case, using the labels the app shows.
4. Keep notes short and factual. Results reach the ticket as a comment.

**9. Check, plan, run and report**

1. Write a new case file with `case_draft`, which writes the file only when it has no errors. After any other edit, run `case_check` and fix every error by its rule id. A warning stays only with a reason.
2. Run `run_plan` for the selection and the environment before any run. It lists the logins, the resolver for each challenge, the person steps and the reason a case would be blocked. Fix what blocks a case first, or tell the person what it needs, such as a missing secret or fixture.
3. Start the run with `run_start` and follow it with `run_status`. The run goes on after the call returns.
4. When `run_status` reports pending prompts, read them with `prompt_list` and relay each one to the person as written, with its screenshot. Send their answer back with `prompt_answer`. Answer a prompt only with what the person said.
5. Read each outcome with `evidence_get`: `result.json`, its checks, attachments and screenshots. Report a failed or blocked case with its reason. Rerun it only after a change that could fix it.
6. To post results, get the post plan with `report_plan` and post each item through the tracker connector. Then confirm each comment with `report_ack` and its URL, so a later run can edit that comment. Pass the ticket too when several items share a marker.

**10. Rules the tool enforces**

`case_check` reports each of these by id, with the file, the line and a fix. Cite the id when you explain a change.

1. `schema`: case, flow, suite and config shapes, including unknown step kinds.
2. `id-format`, `id-domain`, `id-unique`, `id-retired`: case ids.
3. `case-has-check`: every case checks something.
4. `stage-link`: acceptance and once cases link a ticket.
5. `flow-expands`: `use:` steps and their parameters.
6. `placeholder-resolves`: env, secret and identity placeholders.
7. `no-literal-secret`: secrets written into project files.
8. `fixture-domain`: fixture email domains.
9. `human-only-chain`: resolver chains of human-only kinds.
10. `prod-safe`: writes in `prod_safe` cases.
11. `state-ignored`: git ignores `runs/` and the state folder.
12. `selector-test-id` (warning): selectors without a test id or role.
13. `pin-secret-declared`: the secret a `pin` challenge reads.
