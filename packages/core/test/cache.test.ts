import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CredentialCache, type CredentialKey } from "../src/auth/index.ts";

const key: CredentialKey = { env: "demo", identity: "customer", surface: "web", strategy: "session-cookie" };

describe("CredentialCache", () => {
  let dir: string;
  let cache: CredentialCache;

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "cache-test-")), "credentials");
    cache = new CredentialCache(dir);
  });

  afterEach(async () => {
    await rm(join(dir, ".."), { recursive: true, force: true });
  });

  // Windows has no POSIX file modes
  it.skipIf(process.platform === "win32")("writes mode 0600 and leaves no temp file behind", async () => {
    await cache.save(key, { cookies: [], origins: [] });
    await cache.save(key, { cookies: [{ name: "session", value: "fake-session-cookie" }], origins: [] });

    const files = await readdir(dir);
    expect(files).toEqual(["demo+customer+web+session-cookie.json"]);
    expect((await stat(join(dir, files[0] ?? ""))).mode & 0o777).toBe(0o600);
  });

  it("loads the last saved credential with its expiry as an ISO time", async () => {
    await cache.save(key, { accessToken: "fake-access-1" });
    await cache.save(key, { accessToken: "fake-access-2" }, new Date("2026-11-06T10:00:00.000Z"));

    expect(await cache.load(key)).toEqual({
      credential: { accessToken: "fake-access-2" },
      expiresAt: "2026-11-06T10:00:00.000Z",
    });
  });

  it("keeps keys apart even when their names differ only in where a dash sits", async () => {
    const dashInEnv: CredentialKey = { env: "demo-eu", identity: "admin", surface: "api", strategy: "oauth2" };
    const dashInIdentity: CredentialKey = { env: "demo", identity: "eu-admin", surface: "api", strategy: "oauth2" };
    await cache.save(dashInEnv, "fake-token-a");
    await cache.save(dashInIdentity, "fake-token-b");

    expect((await cache.load(dashInEnv))?.credential).toBe("fake-token-a");
    expect((await cache.load(dashInIdentity))?.credential).toBe("fake-token-b");
    expect(await cache.load({ ...dashInEnv, strategy: "basic" })).toBeUndefined();
  });

  it("delete removes the credential and ignores one that is not there", async () => {
    await cache.save(key, "fake-token");

    await cache.delete(key);
    await cache.delete(key);

    expect(await cache.load(key)).toBeUndefined();
  });
});
