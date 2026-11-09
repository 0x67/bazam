# Challenge service

`bazam exec` and every runner target run their command under a challenge service, so a Selenium, pytest or Playwright Test suite gets email OTPs, TOTP codes and a person's answers the same way a YAML case does. The service listens on `127.0.0.1` for as long as the command runs and answers each request with the resolver chain the env's `challenges` config lists for the kind.

**Variables**

1. `BAZAM_CHALLENGE_URL` holds the full endpoint, `http://127.0.0.1:<port>/challenge`. Post to it as given.
2. `BAZAM_CHALLENGE_TOKEN` holds the bearer token every request must carry.
3. Leave `BAZAM_CHALLENGE_TOKEN` and `BAZAM_CHALLENGE_URL` out of the environment of an app server the suite starts. A Playwright `webServer` inherits `process.env`, and `webServer.env` only overrides the keys it names, so start the server with `env -u BAZAM_CHALLENGE_TOKEN -u BAZAM_CHALLENGE_URL <command>` or set both to `""` in `webServer.env`.

**Request**

`POST` the endpoint with `authorization: Bearer <token>`, `content-type: application/json` and a JSON body of at most 16 KiB:

1. `kind` (required): `otp-email`, `otp-sms`, `totp`, `passkey`, `pin`, `face`, `biometric` or a kind a plugin adds.
2. `caseId` (required): the case the test belongs to. It starts with a letter or digit and holds only letters, digits, dots, dashes and underscores.
3. `params` (optional): string values the resolvers read. `otp-mailpit` needs `recipient`, the address the code was mailed to; `totp` needs `seed`, the name of the secret that holds the seed; `otp-http-hook` needs `url` and `field`; `pin-secret` needs `secret`, the name of the secret that holds the PIN.
4. `identity` (optional): the identity a person's prompt names, `tester` when left out.
5. `step` (optional): a positive integer, 1 when left out. A test that answers several challenges of one kind in one case passes it to tell their prompts apart.

The service refuses any other field.

**Answers**

1. 200 with `{ "value": "<code>" }`: type the value into the app.
2. 200 with `{ "done": true }`: a person or a resolver acted in the app. Action kinds (`passkey`, `face`, `biometric`) and kinds the config lists as human-only answer this way.
3. 400: the body is not JSON or not a request, or it names an unknown kind.
4. 401: the bearer token is missing or wrong.
5. 404: the path is not `/challenge`.
6. 405: the method is not `POST`.
7. 413: the body is over 16 KiB.
8. 500: the env's chain for the kind names a resolver that does not answer that kind, or names an automated resolver for a human-only kind. The service also answers 500 when it fails in an unexpected way.
9. 502: the env has no resolver chain for the kind, no resolver in the chain can run outside a browser, or the resolvers that ran gave no answer.
10. 503: the service is stopping because the command or the run ended.
11. 504: the person gave no answer within their window of five minutes.

Every status other than 200 comes with `{ "error": "<reason>" }`.

**Clients**

1. A suite in a project with `@bazam/core` installed can call `requestChallenge` from `@bazam/core/challenge`.
2. TypeScript and JavaScript suites in a project without `@bazam/core` installed copy `examples/clients/ts/challenge-client.ts`. It imports only `node:http` and exports the same `requestChallenge` and `ChallengeRequestFailed`:

   ```ts
   import { requestChallenge } from "./challenge-client.ts";

   const answer = await requestChallenge({ kind: "totp", caseId: "SHOP-LOGIN-001", params: { seed: "shop-totp" } });
   if ("value" in answer) await page.getByLabel("Code").fill(answer.value);
   ```

3. Python suites copy `examples/clients/python/challenge_client.py`, which needs only the standard library:

   ```python
   from challenge_client import request_challenge

   answer = request_challenge("otp-email", "SHOP-LOGIN-002", params={"recipient": "buyer@example.test"})
   driver.find_element(By.NAME, "code").send_keys(answer["value"])
   ```

4. Each client reads the two variables and refuses, before it sends anything, a URL whose scheme is not `http` or whose host is not `127.0.0.1`, `localhost` or `[::1]`. It never sends through a proxy, even with `HTTP_PROXY` set.
5. Each client waits until the service answers. A TypeScript caller can set `timeoutMs` or pass a `signal`, and a Python caller can set `timeout` in seconds. The limit counts the time a prompt waits in the queue as well.
6. A status other than 200 raises `ChallengeRequestFailed`, whose `status` holds the status and whose message reads `challenge service answered <status>: <error>`.

**Other languages**

Any HTTP client works when it sends only to the loopback URL, bypasses every proxy and sets no overall timeout shorter than a person's window. With `curl`:

```sh
curl --noproxy '*' --silent --show-error \
  --request POST "$BAZAM_CHALLENGE_URL" \
  --header "authorization: Bearer $BAZAM_CHALLENGE_TOKEN" \
  --header 'content-type: application/json' \
  --data '{"kind":"otp-email","caseId":"SHOP-LOGIN-002","params":{"recipient":"buyer@example.test"}}'
```

**When to ask**

1. The service arms no resolver, so a test asks only after the app has sent the code: submit the sign-in form first, then call the client.
2. `otp-http-hook` reads the hook once and does not wait for a code.
3. `otp-mailpit` also takes mail that arrived up to 30 seconds before it first reads the inbox, so a code mailed just before the request still counts.
4. A request a person answers can take as long as their window. Raise your framework's per-test timeout for tests that may ask a person. With `--workers`, prompts reach the person one at a time, so a test also waits for the prompts asked before its own.
5. A test runner that gives up and closes the request takes its prompt away from the person.
