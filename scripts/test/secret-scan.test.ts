import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { BRAND } from "../../packages/core/src/brand.ts";
import { totpCode } from "../../packages/resolvers/src/totp.ts";

const root = path.resolve(import.meta.dirname, "../..");
const { zipSync } = createRequire(path.join(root, "packages", "driver-web", "package.json"))("fflate") as {
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array;
};

const PIN = "7351";
const KEY = "fake key/for scan tests";
const SEED = "JBSWY3DPEHPK3PXP";
const SECRETS = { SCAN_TEST_PIN: PIN, SCAN_TEST_KEY: KEY, SCAN_TEST_SEED: SEED };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RUN_DIR = path.join("runs", "20260101-000000-abcd");
const CASE_DIR = path.join(RUN_DIR, "CASE-1");

interface Scan {
  status: number | null;
  stdout: string;
  stderr: string;
}

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  write(
    dir,
    BRAND.configFile,
    [
      "envs:",
      "  test: { production: false, hosts: [app.example.test] }",
      "secrets:",
      "  providers: [env]",
      "  names: [SCAN_TEST_PIN, SCAN_TEST_KEY, SCAN_TEST_SEED]",
    ].join("\n"),
  );
  return dir;
}

function write(dir: string, file: string, content: string | Uint8Array): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

// bytes that are not UTF-8, as a screenshot's are
function binary(text: string): Uint8Array {
  return Uint8Array.from([...PNG_SIGNATURE, ...Buffer.from(text), 0xff, 0xfe]);
}

// the evidence of a case that ran for ten seconds and read a TOTP code and a mailed one
function caseResult(): string {
  return JSON.stringify({
    status: "pass",
    challenges: [
      { step: 1, kind: "totp", resolver: "totp" },
      { step: 2, kind: "otp-email", resolver: "otp-mailpit" },
    ],
    startedAt: "2026-01-01T00:00:10.000Z",
    finishedAt: "2026-01-01T00:00:20.000Z",
  });
}

// a Mailpit API that serves the given mail
async function mailpit(mail: readonly { id: string; created: string; text: string }[]): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://mailpit.example.test");
    const start = Number(url.searchParams.get("start") ?? "0");
    const body =
      url.pathname === "/api/v1/messages"
        ? { total: mail.length, messages: mail.slice(start).map(({ id, created }) => ({ ID: id, Created: created })) }
        : { Text: mail.find(({ id }) => url.pathname === `/api/v1/message/${id}`)?.text };
    response.setHeader("content-type", "application/json").end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// asynchronous, so a Mailpit stub in this process can answer the scan
function scan(dir: string, args: readonly string[] = [], secrets: Record<string, string> = SECRETS): Promise<Scan> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, "scripts", "secret-scan.ts"), dir, ...args],
      { encoding: "utf8", env: { ...process.env, ...secrets } },
      (error, stdout, stderr) => resolve({ status: error === null ? 0 : (error.code as number), stdout, stderr }),
    );
  });
}

it("names the file and the secret of each hit, inside deflated zip entries too, and never prints a value", async () => {
  const dir = project();
  write(dir, path.join(CASE_DIR, "case.log"), `fill("${PIN}")\n`);
  const body = new URLSearchParams({ key: KEY }).toString();
  const network = Array.from(
    { length: 40 },
    (_, i) => `{"url":"http://app.example.test/form?n=${i}","postData":"${body}"}`,
  ).join("\n");
  const zip = zipSync({ "trace.network": Buffer.from(network) });
  // the entry is deflated, so only an unzipped entry shows the form-encoded key
  expect(Buffer.from(zip).includes("scan+tests")).toBe(false);
  write(dir, path.join(CASE_DIR, "01-trace.zip"), zip);
  write(dir, path.join(CASE_DIR, "01-shot.png"), binary(KEY));
  write(dir, path.join(RUN_DIR, "CASE-2", "result.json"), '{ "status": "pass" }\n');

  const result = await scan(dir);

  expect(result.status).toBe(1);
  expect(result.stdout).toBe(
    [
      `${path.join(CASE_DIR, "01-shot.png")}: SCAN_TEST_KEY`,
      `${path.join(CASE_DIR, "01-trace.zip")}!trace.network: SCAN_TEST_KEY`,
      `${path.join(CASE_DIR, "case.log")}: SCAN_TEST_PIN`,
      "",
    ].join("\n"),
  );
  expect(`${result.stdout}${result.stderr}`).not.toContain(PIN);
  expect(`${result.stdout}${result.stderr}`).not.toContain("scan tests");
});

it("finds a short value after a JSON or percent escape and in bytes that are neither UTF-8 nor an image", async () => {
  const dir = project();
  // how JSON.stringify writes observed text that spans two lines
  write(dir, path.join(CASE_DIR, "observed.json"), JSON.stringify({ observed: `Your PIN\n${PIN}` }));
  write(
    dir,
    path.join(CASE_DIR, "01-trace.zip"),
    zipSync({
      "post.network": Buffer.from(`{"postData":"payload=%7B%22pin%22%3A%22${PIN}%22%7D"}`),
      "url.network": Buffer.from(`{"url":"http://app.example.test/next?to=%2Fconfirm%3Fpin%3D${PIN}"}`),
      "resources/a1.dat": Uint8Array.from([...Buffer.from(`pin=${PIN}&note=`), 0xe9, 0xff]),
    }),
  );
  write(dir, path.join(CASE_DIR, "case.log"), Uint8Array.from([...Buffer.from(`fill ${PIN} `), 0xff]));

  const result = await scan(dir);

  expect(result.stdout).toBe(
    [
      `${path.join(CASE_DIR, "01-trace.zip")}!post.network: SCAN_TEST_PIN`,
      `${path.join(CASE_DIR, "01-trace.zip")}!url.network: SCAN_TEST_PIN`,
      `${path.join(CASE_DIR, "01-trace.zip")}!resources/a1.dat: SCAN_TEST_PIN`,
      `${path.join(CASE_DIR, "case.log")}: SCAN_TEST_PIN`,
      `${path.join(CASE_DIR, "observed.json")}: SCAN_TEST_PIN`,
      "",
    ].join("\n"),
  );
  expect(result.status).toBe(1);
});

it("passes a short value inside numbers, run ids, result.json fields the harness writes and images", async () => {
  const dir = project();
  const runDir = path.join("runs", `20260101-000000-${PIN}`);
  write(dir, path.join(runDir, "summary.md"), `# Run 20260101-000000-${PIN}\n`);
  write(
    dir,
    path.join(runDir, "CASE-1", "result.json"),
    JSON.stringify({
      runId: `20260101-000000-${PIN}`,
      status: "pass",
      seed: Number(PIN),
      values: { n: PIN },
      durationMs: Number(PIN),
    }),
  );
  const trace = [`{"time":12.${PIN},"wallTime":17${PIN}0000000}`, `{"time":${PIN}.5,"pageId":"page@a${PIN}b"}`];
  write(dir, path.join(runDir, "CASE-1", "01-trace.zip"), zipSync({ "trace.trace": Buffer.from(trace.join("\n")) }));
  write(dir, path.join(runDir, "CASE-1", "01-shot.png"), binary(PIN));

  const result = await scan(dir);

  expect(result.stderr).toContain("0 hits in 4 files");
  expect(result.stdout).toBe("");
  expect(result.status).toBe(0);
});

it("finds the values a cached credential holds for the run to mask, and none of its other fields", async () => {
  const dir = project();
  const cache = path.join(BRAND.stateDir, "credentials");
  const cookie = { name: "session", domain: "app.example.test", path: "/", expires: -1, secure: false };
  write(
    dir,
    path.join(cache, "test+customer+web+session-cookie.json"),
    JSON.stringify({
      credential: {
        cookies: [
          { ...cookie, value: "fake-session-cookie-for-scan-tests", httpOnly: true },
          { ...cookie, name: "lang", value: "en-GB", httpOnly: false },
        ],
        origins: [],
      },
    }),
  );
  write(
    dir,
    path.join(cache, "test+client+api+oauth2.json"),
    JSON.stringify({
      credential: {
        accessToken: "fake-access-token-for-scan-tests",
        refreshToken: "fake-refresh-token-for-scan-tests",
      },
    }),
  );
  write(
    dir,
    path.join(cache, "test+newcomer+web+passkey-virtual.json"),
    JSON.stringify({
      credential: [
        {
          id: "fake-passkey-id",
          rpId: "app.example.test",
          userHandle: "fake-user-handle",
          privateKey: "fake/passkey+private/key==",
          publicKey: "fake-public-key",
          signCount: 1,
        },
      ],
    }),
  );
  write(dir, path.join(CASE_DIR, "case.log"), "Cookie: session=fake-session-cookie-for-scan-tests\n");
  write(dir, path.join(CASE_DIR, "result.json"), JSON.stringify({ observed: "fake-refresh-token-for-scan-tests" }));
  const passkey = Buffer.from("fake/passkey+private/key==").toString("base64");
  write(dir, path.join(CASE_DIR, "01-trace.zip"), zipSync({ "trace.network": Buffer.from(`{"key":"${passkey}"}`) }));
  write(
    dir,
    path.join(RUN_DIR, "summary.md"),
    "session lang en-GB app.example.test fake-passkey-id fake-user-handle fake-public-key\n",
  );

  const result = await scan(dir);

  expect(result.stdout).toBe(
    [
      `${path.join(CASE_DIR, "01-trace.zip")}!trace.network: credential test+newcomer+web+passkey-virtual`,
      `${path.join(CASE_DIR, "case.log")}: credential test+customer+web+session-cookie`,
      `${path.join(CASE_DIR, "result.json")}: credential test+client+api+oauth2`,
      "",
    ].join("\n"),
  );
  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain("for-scan-tests");
});

it("finds the TOTP codes and mailed codes from the time of the run that read them, and no others", async () => {
  const dir = project();
  const started = Date.parse("2026-01-01T00:00:10.000Z");
  const totp = totpCode(SEED, new Date(started));
  const laterTotp = totpCode(SEED, new Date(started + 3_600_000));
  write(dir, path.join(CASE_DIR, "result.json"), caseResult());
  write(dir, path.join(CASE_DIR, "case.log"), `fill("${totp}")\n`);
  write(dir, path.join(RUN_DIR, "CASE-2", "case.log"), `fill("482913")\n`);
  // a code of an hour later and one mailed the day before belong to other runs
  write(dir, path.join(RUN_DIR, "run.log"), `${laterTotp} 731864\n`);
  const url = await mailpit([
    { id: "in-run", created: "2026-01-01T00:00:15.000Z", text: "Your sign-in code is 482913." },
    { id: "day-before", created: "2025-12-31T00:00:15.000Z", text: "Your sign-in code is 731864." },
  ]);

  const result = await scan(dir, ["--totp-seed", "SCAN_TEST_SEED", "--mailpit", url]);

  expect(result.stdout).toBe(
    [
      `${path.join(RUN_DIR, "CASE-1", "case.log")}: TOTP code of SCAN_TEST_SEED`,
      `${path.join(RUN_DIR, "CASE-2", "case.log")}: code mailed to Mailpit`,
      "",
    ].join("\n"),
  );
  expect(result.status).toBe(1);
});

it("fails when a secret has no value or the runs folder holds no files, since it would check nothing", async () => {
  const dir = project();
  write(dir, path.join(RUN_DIR, "summary.md"), "# Run\n");

  const missing = await scan(dir, [], { SCAN_TEST_PIN: PIN, SCAN_TEST_SEED: SEED });

  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain("secret SCAN_TEST_KEY: no value from providers [env]");

  rmSync(path.join(dir, "runs"), { recursive: true });
  mkdirSync(path.join(dir, "runs"));

  const empty = await scan(dir);

  expect(empty.status).toBe(2);
  expect(empty.stderr).toContain("holds no files");
});

it("fails when a run read codes the options give no source for, or a cached credential has no known owner", async () => {
  const dir = project();
  write(dir, path.join(CASE_DIR, "result.json"), caseResult());
  const url = await mailpit([{ id: "in-run", created: "2026-01-01T00:00:15.000Z", text: "Your code is 482913." }]);

  const noSeed = await scan(dir, ["--mailpit", url]);
  const noMailpit = await scan(dir, ["--totp-seed", "SCAN_TEST_SEED"]);
  const noMail = await scan(dir, ["--totp-seed", "SCAN_TEST_SEED", "--mailpit", await mailpit([])]);
  write(dir, path.join(BRAND.stateDir, "credentials", "test+customer+web+unknown.json"), '{"credential":"x"}');
  const unknown = await scan(dir, ["--totp-seed", "SCAN_TEST_SEED", "--mailpit", url]);

  expect([noSeed.status, noMailpit.status, noMail.status, unknown.status]).toEqual([2, 2, 2, 2]);
  expect(noSeed.stderr).toContain("run 20260101-000000-abcd used TOTP codes; give --totp-seed");
  expect(noMailpit.stderr).toContain("run 20260101-000000-abcd read codes from Mailpit; give --mailpit its URL");
  expect(noMail.stderr).toContain("holds no mail from that time");
  expect(unknown.stderr).toContain("cannot tell which values of the cached test+customer+web+unknown.json are secret");
});
