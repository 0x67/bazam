import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import { main } from "../src/main.ts";
import { cli } from "./support/project.ts";

// the RFC 6238 test key, "12345678901234567890" in base32
const TEST_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** Asks the service for a TOTP code, writes what it got to client-result.json and exits with its first argument. */
const CLIENT = `import { writeFileSync } from "node:fs";
const url = process.env[${JSON.stringify(`${BRAND.envPrefix}CHALLENGE_URL`)}];
const token = process.env[${JSON.stringify(`${BRAND.envPrefix}CHALLENGE_TOKEN`)}];
const response = await fetch(url, {
  method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ kind: "totp", caseId: "EXT-TOTP-001", params: { seed: "DEMO_TOTP_SEED" } }),
});
writeFileSync("client-result.json", JSON.stringify({ url, status: response.status, body: await response.json() }));
process.exit(Number(process.argv[2] ?? 0));
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-exec-"));
  const config = {
    envs: { demo: { production: false, hosts: ["127.0.0.1"], challenges: { totp: ["totp"] } } },
  };
  await write(BRAND.configFile, JSON.stringify(config, null, 2));
  await write(join(BRAND.stateDir, "secrets.env"), `DEMO_TOTP_SEED=${TEST_SEED}\n`);
  await write("client.mjs", CLIENT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** The RFC 6238 code of the test key for the 30 second step that holds `at`. */
function totpAt(at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", "12345678901234567890").update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("exec", () => {
  it("gives the command a code over the service, passes its exit code through and stops the service", async () => {
    const started = Date.now();
    const { code } = await cli(
      ["exec", "--env", "demo", "--", process.execPath, "client.mjs", "7"],
      root,
    );
    expect(code).toBe(7);
    const result = JSON.parse(await readFile(join(root, "client-result.json"), "utf8")) as {
      url: string;
      status: number;
      body: { value: string };
    };
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/challenge$/);
    expect(result.status).toBe(200);
    // the resolver waits for the next step when the current one is about to end
    expect([totpAt(started), totpAt(started + 30_000)]).toContain(result.body.value);
    await expect(fetch(result.url, { method: "POST" })).rejects.toThrow();
  });

  it("exits 128 plus the signal number when a signal ends the command", async () => {
    const script = "process.kill(process.pid, 'SIGTERM')";
    const { code } = await cli(
      ["exec", "--env", "demo", "--", process.execPath, "-e", script],
      root,
    );
    expect(code).toBe(128 + 15);
  });

  it("sends the command SIGINT on Ctrl-C and waits for it to end", async () => {
    const interrupt = new AbortController();
    const script = "require('node:fs').writeFileSync('ready', ''); setInterval(() => {}, 1000)";
    const io = {
      stdout: { write: () => true },
      stderr: { write: () => true },
      cwd: root,
      signal: interrupt.signal,
    };
    const running = main(["exec", "--env", "demo", "--", process.execPath, "-e", script], io);
    await vi.waitFor(() => expect(existsSync(join(root, "ready"))).toBe(true), {
      timeout: 10_000,
      interval: 20,
    });
    interrupt.abort();
    expect(await running).toBe(128 + 2);
  });

  it("exits 127 for a command that is not found and 126 for one that cannot run", async () => {
    const missing = await cli(["exec", "--env", "demo", "--", "./no-such-command"], root);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain("error: cannot run ./no-such-command:");
    await write("not-executable.sh", "#!/bin/sh\nexit 0\n");
    expect((await cli(["exec", "--env", "demo", "--", "./not-executable.sh"], root)).code).toBe(
      126,
    );
  });

  it("exits 2 without a command or an env", async () => {
    const noCommand = await cli(["exec", "--env", "demo"], root);
    expect(noCommand.code).toBe(ExitCode.CouldNotStart);
    expect(noCommand.stderr).toContain("exec needs a command to run");
    const noEnv = await cli(["exec", "--", process.execPath, "client.mjs"], root);
    expect(noEnv.code).toBe(ExitCode.CouldNotStart);
    expect(noEnv.stderr).toContain("--env is required; envs: demo");
  });
});
