# Contributing

**Sign-off**

1. Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). There is no contributor license agreement.
2. Sign off every commit with `git commit -s`. The flag adds a `Signed-off-by: Your Name <you@example.test>` line, which certifies that you wrote the change or have the right to submit it under the project's license.
3. Pull requests with unsigned commits are not merged. To sign off commits you already made, run `git rebase --signoff main` and force-push the branch.

**Git hooks**

1. `pnpm install` runs the `prepare` script, which installs the Vite+ hook dispatcher in `.vite-hooks/_`. Working on the repository needs Node 22.22.1 or later.
2. Before each commit, `vp staged` runs `vp check --fix` on the staged files. It formats them, applies the lint fixes it can, and refuses the commit when a format, lint or type error remains.
3. Before each push, the hook runs `pnpm check && pnpm test`.
4. Do not skip the hooks with `--no-verify`. Run `pnpm check` and `pnpm test` yourself to see what a hook would refuse.
5. A machine that commits without a developer, such as a bot or a release job, sets `VP_GIT_HOOKS=0` in the environment of the process that runs `git commit`. The hooks then exit without running, and `pnpm install` with the same setting installs no dispatcher.
6. `pnpm exec vp hooks status` shows whether the dispatcher is active in a clone.

**License**

1. Contributions are licensed under the Apache License 2.0, the same as the project (see `LICENSE`).
