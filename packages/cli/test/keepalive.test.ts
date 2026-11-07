import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CredentialCache, withRefreshLock, type CredentialKey, type JsonValue } from "@bazam/core/auth";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import { main } from "../src/main.ts";
import { cli, type CliRun } from "./support/project.ts";

const KEY: CredentialKey = { env: "demo", identity: "customer", surface: "web", strategy: "fake-session" };

/**
 * A path plugin with two cached strategies. `fake-session` refreshes and revokes, refuses to refresh a revoked
 * session, and records whether the refresh lock file existed during each refresh; `fake-fixed` can do neither.
 * A `fake-session` credential with `refreshable: false` cannot refresh, and one with `logout: true` is revoked
 * and deleted from the cache as its refresh starts, as by a logout that ran right after keepalive's cache check.
 */
function fakeStrategies(lockFile: string, revokedFile: string, credentialFile: string): string {
  return `import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
const revokedFile = ${JSON.stringify(revokedFile)};
const logOut = (credential) => {
  appendFileSync(revokedFile, JSON.stringify({ token: credential.token }) + "\\n");
  rmSync(${JSON.stringify(credentialFile)});
};
const anything = { safeParse: (value) => ({ success: true, data: value }) };
const session = {
  name: "fake-session",
  config: anything,
  cacheable: true,
  keepaliveMs: 20,
  acquire: async () => {
    throw new Error("the fake session logs in only in a run");
  },
  apply: async () => {},
  canRefresh: (credential) => {
    if (credential.refreshable !== false) return true;
    if (credential.logout === true) logOut(credential);
    return false;
  },
  refresh: async (credential) => {
    if (credential.logout === true) logOut(credential);
    if (existsSync(revokedFile) && readFileSync(revokedFile, "utf8").includes(JSON.stringify(credential.token)))
      throw new Error("the fake server refuses to refresh a revoked session");
    return {
      token: "fake-session-" + (credential.lockHeld.length + 1),
      lockHeld: [...credential.lockHeld, existsSync(${JSON.stringify(lockFile)})],
    };
  },
  revoke: async (credential, config, ctx) => {
    if (credential.token === "fake-unrevokable") throw new Error("the fake server refused the revoke");
    const record = { env: ctx.env.name, identity: ctx.identity, token: credential.token, config, fields: ctx.fields };
    appendFileSync(revokedFile, JSON.stringify(record) + "\\n");
  },
  secrets: (credential) => [credential.token],
};
const fixed = { ...session, name: "fake-fixed", refresh: undefined, revoke: undefined };
export default { name: "fake-strategies", apiVersion: 1, authStrategies: [session, fixed] };
`;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-keepalive-"));
  const stem = (key: readonly string[]): string => key.map(encodeURIComponent).join("+");
  const lockFile = join(root, BRAND.stateDir, "locks", `${stem([KEY.env, KEY.identity, KEY.surface])}.lock`);
  const credentialFile = join(credentialsDir(), `${stem([KEY.env, KEY.identity, KEY.surface, KEY.strategy])}.json`);
  const config = {
    envs: {
      demo: { production: false, hosts: ["127.0.0.1"], vars: { AUDIENCE: "demo-app" } },
      uat: { production: false, hosts: ["127.0.0.1"], vars: { AUDIENCE: "uat-app" } },
    },
    identities: {
      customer: {
        fixture: "customer",
        auth: {
          web: { strategy: "fake-session", with: { audience: "${env.AUDIENCE}", email: "${identity.customer.email}" } },
          api: { strategy: "fake-session", from: "web" },
        },
      },
      admin: { auth: { web: { strategy: "fake-fixed", with: {} } } },
    },
    plugins: ["./fake-strategies.mjs"],
  };
  await write(BRAND.configFile, JSON.stringify(config, null, 2));
  await write("fake-strategies.mjs", fakeStrategies(lockFile, join(root, "revoked.jsonl"), credentialFile));
  await write("fixtures/identities.local.yaml", "customer:\n  email: customer@example.test\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const credentialsDir = (): string => join(root, BRAND.stateDir, "credentials");
const cache = (): CredentialCache => new CredentialCache(credentialsDir());

/** Replaces the auth settings of the customer identity. */
async function customerAuth(auth: Record<string, unknown>): Promise<void> {
  const path = join(root, BRAND.configFile);
  const config = JSON.parse(await readFile(path, "utf8")) as { identities: { customer: { auth: unknown } } };
  config.identities.customer.auth = auth;
  await writeFile(path, JSON.stringify(config, null, 2));
}

function seed(key: Partial<CredentialKey>, credential: JsonValue): Promise<void> {
  return cache().save({ ...KEY, ...key }, credential);
}

/** Whether the refresh lock was held, for each refresh of the cached customer credential so far. */
async function lockHeld(): Promise<boolean[]> {
  const cached = await cache().load(KEY);
  return (cached?.credential as { lockHeld?: boolean[] } | undefined)?.lockHeld ?? [];
}

/** Runs the CLI in-process until `stop` is called, as a Ctrl-C in the bin would. */
function startCli(...argv: string[]): { stop(): void; done: Promise<CliRun> } {
  const interrupt = new AbortController();
  let stdout = "";
  let stderr = "";
  const code = main(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    cwd: root,
    signal: interrupt.signal,
  });
  return { stop: () => interrupt.abort(), done: code.then((exit) => ({ code: exit, stdout, stderr })) };
}

/** How the CLI ended, or undefined when it still ran after two seconds; it is stopped either way. */
async function endsByItself(running: { stop(): void; done: Promise<CliRun> }): Promise<CliRun | undefined> {
  const ended = await Promise.race([running.done, sleep(2_000, undefined)]);
  running.stop();
  await running.done;
  return ended;
}

/** Waits until keepalive has refreshed the cached customer credential `count` times. */
async function refreshes(count: number): Promise<void> {
  await vi.waitFor(async () => expect((await lockHeld()).length).toBeGreaterThanOrEqual(count), {
    timeout: 10_000,
    interval: 20,
  });
}

describe("keepalive", () => {
  it("refreshes on the interval while holding the lock", async () => {
    await seed({}, { token: "fake-session-0", lockHeld: [] });
    const running = startCli("keepalive", "--env", "demo", "--as", "customer");
    await refreshes(3);
    running.stop();
    const { code, stdout, stderr } = await running.done;
    expect(code).toBe(ExitCode.Pass);
    expect((await lockHeld()).every((held) => held)).toBe(true);
    expect(stderr.match(/refreshed customer\/web/g)?.length).toBeGreaterThanOrEqual(3);
    // the api surface shares the web credential, so only web is kept alive
    expect(stdout).toBe("stopped keeping customer alive on web in env demo\n");
    expect(existsSync(join(root, BRAND.stateDir, "locks", "demo+customer+web.lock"))).toBe(false);
  });

  it("refuses an identity with no cached credential, and stops when the strategy cannot refresh", async () => {
    const empty = await cli(["keepalive", "--env", "demo", "--as", "customer"], root);
    expect(empty.code).toBe(ExitCode.CouldNotStart);
    expect(empty.stderr).toContain("no cached web credential for customer to keep alive");

    await seed({ identity: "admin", strategy: "fake-fixed" }, { token: "fake-fixed-0", lockHeld: [] });
    const fixed = await cli(["keepalive", "--env", "demo", "--as", "admin"], root);
    expect(fixed.code).toBe(ExitCode.CouldNotStart);
    expect(fixed.stderr).toContain("the web credential of admin cannot refresh");

    const missing = await cli(["keepalive", "--env", "demo"], root);
    expect(missing.stderr).toContain("--as is required; identities: customer, admin");
  });

  it("stops once logout deletes the credential, without refreshing or saving it again", async () => {
    await seed({}, { token: "fake-session-0", lockHeld: [] });
    const running = startCli("keepalive", "--env", "demo", "--as", "customer");
    await refreshes(2);
    const logout = await cli(["logout", "--as", "customer"], root);
    expect(logout.stdout).toBe("logged out customer/web in env demo, revoked\n");
    const ended = await endsByItself(running);
    expect(ended?.code).toBe(ExitCode.Pass);
    expect(ended?.stderr).toContain("customer/web was logged out; stopped keeping it alive");
    expect(await readdir(credentialsDir())).toEqual([]);
  });

  it("stops when a logout deletes the credential before a refresh that then fails", async () => {
    await seed({}, { token: "fake-session-0", lockHeld: [], logout: true });
    const { code, stdout, stderr } = await cli(["keepalive", "--env", "demo", "--as", "customer"], root);
    expect(code).toBe(ExitCode.Pass);
    expect(stderr).toContain("customer/web was logged out; stopped keeping it alive");
    expect(stderr).not.toContain("refuses to refresh");
    expect(stdout).toBe("stopped keeping customer alive on web in env demo\n");
    expect(await readdir(credentialsDir())).toEqual([]);
  });

  it("stops when a logout deletes the credential before a refresh that then cannot run", async () => {
    await seed({}, { token: "fake-session-0", lockHeld: [], refreshable: false, logout: true });
    const { code, stdout, stderr } = await cli(["keepalive", "--env", "demo", "--as", "customer"], root);
    expect(code).toBe(ExitCode.Pass);
    expect(stderr).toContain("customer/web was logged out; stopped keeping it alive");
    expect(stderr).not.toContain("cannot refresh");
    expect(stdout).toBe("stopped keeping customer alive on web in env demo\n");
    expect(await readdir(credentialsDir())).toEqual([]);
  });

  it("exits 2 when a refresh fails while the credential is still cached", async () => {
    await seed({}, { token: "fake-session-0", lockHeld: [], refreshable: false });
    const declined = await cli(["keepalive", "--env", "demo", "--as", "customer"], root);
    expect(declined.code).toBe(ExitCode.CouldNotStart);
    expect(declined.stderr).toContain(
      `the web credential of customer cannot refresh; give its auth settings a refresh in ${BRAND.configFile}`,
    );
    expect(declined.stderr).not.toContain("was logged out");

    await write("revoked.jsonl", `${JSON.stringify({ token: "fake-session-0" })}\n`);
    await seed({}, { token: "fake-session-0", lockHeld: [] });
    const refused = await cli(["keepalive", "--env", "demo", "--as", "customer"], root);
    expect(refused.code).toBe(ExitCode.CouldNotStart);
    expect(refused.stderr).toContain("the fake server refuses to refresh a revoked session");
    expect(refused.stderr).not.toContain("was logged out");
    expect(await cache().load(KEY)).toBeDefined();
  });

  it("does not save back a credential deleted while its refresh waited for the lock", async () => {
    await seed({}, { token: "fake-session-0", lockHeld: [] });
    const running = startCli("keepalive", "--env", "demo", "--as", "customer");
    await refreshes(1);
    // stands in for a logout that took the lock after the next refresh found the credential still cached
    await withRefreshLock(join(root, BRAND.stateDir, "locks"), KEY, async () => {
      await sleep(200);
      await cache().delete(KEY);
    });
    const ended = await endsByItself(running);
    expect(ended?.code).toBe(ExitCode.Pass);
    expect(ended?.stderr).toContain("customer/web was logged out; stopped keeping it alive");
    expect(await readdir(credentialsDir())).toEqual([]);
  });

  it("keeps the surfaces it can alive and logs why it skips the others", async () => {
    await customerAuth({
      web: { strategy: "fake-session", with: {} },
      api: { strategy: "fake-fixed", with: {} },
      mobile: { strategy: "fake-session", with: {} },
    });
    const none = await cli(["keepalive", "--env", "demo", "--as", "customer"], root);
    expect(none.code).toBe(ExitCode.CouldNotStart);
    expect(none.stderr).toContain("no surface of customer could be kept alive");

    await seed({}, { token: "fake-session-0", lockHeld: [] });
    await seed({ surface: "api", strategy: "fake-fixed" }, { token: "fake-fixed-0", lockHeld: [] });
    const running = startCli("keepalive", "--env", "demo", "--as", "customer");
    await refreshes(3);
    running.stop();
    const { code, stdout, stderr } = await running.done;
    expect(code).toBe(ExitCode.Pass);
    expect(stdout).toBe("stopped keeping customer alive on web in env demo\n");
    expect(stderr).toContain("stopped keeping customer/api alive: the api credential of customer cannot refresh");
    expect(stderr).toContain("stopped keeping customer/mobile alive: no cached mobile credential for customer");
  });
});

describe("logout", () => {
  async function revoked(): Promise<unknown[]> {
    const text = await readFile(join(root, "revoked.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown);
  }

  it("revokes and deletes the cached credentials of every env, and leaves other identities alone", async () => {
    await seed({}, { token: "fake-session-demo", lockHeld: [] });
    await seed({ env: "uat" }, { token: "fake-session-uat", lockHeld: [] });
    await seed({ identity: "admin", strategy: "fake-fixed" }, { token: "fake-fixed-0", lockHeld: [] });

    const { code, stdout } = await cli(["logout", "--as", "customer", "--json"], root);
    expect(code).toBe(ExitCode.Pass);
    const done = { identity: "customer", surface: "web", strategy: "fake-session", revoked: true };
    expect(JSON.parse(stdout)).toEqual({
      loggedOut: [
        { env: "demo", ...done },
        { env: "uat", ...done },
      ],
    });
    const fields = { email: "customer@example.test" };
    expect(await revoked()).toEqual([
      {
        env: "demo",
        identity: "customer",
        token: "fake-session-demo",
        config: { audience: "demo-app", ...fields },
        fields,
      },
      {
        env: "uat",
        identity: "customer",
        token: "fake-session-uat",
        config: { audience: "uat-app", ...fields },
        fields,
      },
    ]);
    expect(await cache().load(KEY)).toBeUndefined();
    expect(await cache().load({ ...KEY, env: "uat" })).toBeUndefined();
    expect(await cache().load({ ...KEY, identity: "admin", strategy: "fake-fixed" })).toBeDefined();
  });

  it("deletes a credential whose revoke fails and exits 1, and deletes one without revoke in one env", async () => {
    await seed({}, { token: "fake-unrevokable", lockHeld: [] });
    await seed({ identity: "admin", strategy: "fake-fixed" }, { token: "fake-fixed-0", lockHeld: [] });
    await seed({ env: "uat", identity: "admin", strategy: "fake-fixed" }, { token: "fake-fixed-1", lockHeld: [] });

    const { code, stdout } = await cli(["logout", "--env", "demo"], root);
    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toBe(
      [
        "logged out admin/web in env demo",
        "logged out customer/web in env demo; revoke failed: the fake server refused the revoke",
        "",
      ].join("\n"),
    );
    expect(await cache().load(KEY)).toBeUndefined();
    expect(await cache().load({ ...KEY, identity: "admin", strategy: "fake-fixed" })).toBeUndefined();
    expect(await cache().load({ ...KEY, env: "uat", identity: "admin", strategy: "fake-fixed" })).toBeDefined();

    const unknown = await cli(["logout", "--as", "ghost"], root);
    expect(unknown.code).toBe(ExitCode.CouldNotStart);
    expect(unknown.stderr).toContain('unknown identity "ghost"');
    const nowhere = await cli(["logout", "--env", "nowhere"], root);
    expect(nowhere.code).toBe(ExitCode.CouldNotStart);
    expect(nowhere.stderr).toContain('unknown env "nowhere"');
  });

  it("deletes what an older config cached under another identity, strategy or env, and keeps passkeys", async () => {
    await seed({ identity: "buyer" }, { token: "fake-session-buyer", lockHeld: [] });
    await seed({ strategy: "fake-fixed" }, { token: "fake-fixed-old", lockHeld: [] });
    await seed({ env: "staging" }, { token: "fake-session-staging", lockHeld: [] });
    await seed({}, { token: "fake-session-demo", lockHeld: [] });
    // the passkey resolver of the web driver keeps its passkeys in the same folder, under its own name
    await seed({ strategy: "passkey-virtual" }, []);

    const renamed = await cli(["logout", "--as", "buyer"], root);
    expect(renamed.code).toBe(ExitCode.Pass);
    expect(renamed.stdout).toBe("logged out buyer/web (fake-session) in env demo, left by an older config\n");

    const { code, stdout } = await cli(["logout", "--json"], root);
    expect(code).toBe(ExitCode.Pass);
    const web = { identity: "customer", surface: "web" };
    expect(JSON.parse(stdout)).toEqual({
      loggedOut: [
        { env: "demo", ...web, strategy: "fake-fixed", revoked: false, stale: true },
        { env: "demo", ...web, strategy: "fake-session", revoked: true },
        { env: "staging", ...web, strategy: "fake-session", revoked: false, stale: true },
      ],
    });
    expect(await revoked()).toMatchObject([{ env: "demo", token: "fake-session-demo" }]);
    expect(await readdir(credentialsDir())).toEqual(["demo+customer+web+passkey-virtual.json"]);
  });
});
