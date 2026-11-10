# bazam

bazam lets AI agents and people write, run and report end-to-end test cases. A case is a YAML file. Automation clears the challenges it can (email OTP, TOTP, passkeys, a PIN read from a secret) and hands the rest to a person (face verification, biometrics). Results go back to the ticket the case came from, and the same case file keeps running as a regression test after the release.

**Status**

Pre-release. Nothing is published to npm yet. Each release is a GitHub Release with one tarball per package, and the Installing a release section of [docs/releasing.md](docs/releasing.md) shows how to install them together. The case format and commands can still change.

**Docs**

1. [External runners](docs/external-runners.md): run a Selenium, pytest, Playwright Test, Cypress or node:test suite as bazam cases, or ingest its result files with `bazam ingest`.
2. [Challenge service](docs/challenge-service.md): how `bazam exec` and runner targets give those suites email OTPs, TOTP codes and a person's answers.
3. [Configuration](docs/configuration.md): the `bazam.config.yaml` keys for runners, targets, process plugins, trackers, bugs, promotion and redaction.
4. [Plugin protocol](docs/plugin-protocol.md): write a plugin in any language as its own process, over JSON-RPC 2.0 on stdin and stdout.
5. [Plugins](docs/plugins.md): write an in-process TypeScript plugin that adds step kinds, including steps that read the page.
6. [CI regression and promotion](docs/ci-regression.md): the GitHub Actions workflows in `examples/ci/` that run the regression suite and promote acceptance cases.
7. [Releasing](docs/releasing.md): cut a release and install one from its GitHub Release tarballs.
8. [Example project](examples/): cases for every step kind, auth strategy and challenge resolver, run against the [demo app](examples/demo-app/README.md).
9. [Authoring skill](skills/author/SKILL.md): how an agent drafts, runs and reports cases through the MCP server that `bazam mcp` starts.

**License**

Apache License 2.0. See `LICENSE` and `NOTICE`.
