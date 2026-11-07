import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Redactor, defaultRedactionRules } from "@bazam/core/redact";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { scrubTrace } from "../src/trace.ts";
import {
  demoEnv,
  ENGINES,
  html,
  launch,
  newEvidence,
  runSteps,
  startSite,
  stepContext,
  tempDir,
  type Site,
} from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BEARER_TOKEN = "fake-bearer-7f3a9c";
const SESSION_COOKIE = "fake-session-5d2e8b";
const OTP = "73915062";
const SECRETS = [BEARER_TOKEN, SESSION_COOKIE, OTP];

const browsers = { chromium, firefox, webkit };

function containing(entries: Record<string, Uint8Array>, secrets: readonly string[]): string[] {
  return Object.entries(entries).flatMap(([name, bytes]) => {
    const text = strFromU8(bytes, true);
    return secrets.filter((secret) => text.includes(secret)).map((secret) => `${name}: ${secret}`);
  });
}

describe("scrubTrace", () => {
  let site: Site;

  beforeAll(async () => {
    site = await startSite({
      "/": (_request, response, current) => {
        response.setHeader("set-cookie", `sid=${SESSION_COOKIE}; Path=/; HttpOnly`);
        html('<label>Code <input data-testid="otp"></label><button onclick="fetch(\'/api/me\')">Check</button>')(
          _request,
          response,
          current,
        );
      },
      "/api/me": (_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end('{"name":"Ops"}');
      },
    });
  });

  afterAll(() => site.close());

  it.each(ENGINES)(
    "scrubs a bearer header, a cookie and a registered OTP from a recorded trace on %s",
    async (engine) => {
      const root = await tempDir();
      const browser = await browsers[engine].launch();
      try {
        const context = await browser.newContext();
        await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
        // how WebSession.setExtraHeaders sends a header
        await context.route(
          () => true,
          (route) =>
            route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${BEARER_TOKEN}` } }),
        );
        const page = await context.newPage();
        await page.goto(`${site.origin}/`);
        await page.getByTestId("otp").fill(OTP);
        await page.getByRole("button", { name: "Check" }).click();
        await page.waitForLoadState("networkidle");
        await context.storageState();
        await context.tracing.stop({ path: join(root, "trace.zip") });
        const raw = await readFile(join(root, "trace.zip"));
        const redactor = new Redactor(defaultRedactionRules());
        redactor.register(OTP);

        const scrubbed = unzipSync(scrubTrace(raw, redactor));

        const before = unzipSync(raw);
        expect(containing(before, SECRETS).sort()).toEqual(
          expect.arrayContaining(SECRETS.map((secret) => `trace.trace: ${secret}`)),
        );
        expect(Object.keys(scrubbed).sort()).toEqual(Object.keys(before).sort());
        expect(containing(scrubbed, SECRETS)).toEqual([]);
        for (const name of ["trace.trace", "trace.network"]) {
          for (const line of strFromU8(scrubbed[name]!)
            .split("\n")
            .filter((line) => line !== ""))
            expect(() => JSON.parse(line)).not.toThrow();
        }
      } finally {
        await browser.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("masks the configured patterns in DOM snapshots and response bodies and keeps timestamps and ids", () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.configure({ patterns: ["ACCT-\\d+"], screenshotSelectors: ["#account"] });
    const snapshot = (text: string) =>
      JSON.stringify({
        type: "frame-snapshot",
        snapshot: { callId: "call@12345678", timestamp: 7391506.2, html: ["DIV", { id: "account" }, text] },
      });
    const zip = zipSync({
      "trace.trace": strToU8(`${snapshot("ACCT-4821")}\n`),
      "resources/0c35.json": strToU8('{"account":"ACCT-4821","sentAt":1731234567890}'),
      "resources/e160.html": strToU8('<div id="account">ACCT-4821</div>'),
    });

    const scrubbed = unzipSync(scrubTrace(zip, redactor));

    expect(strFromU8(scrubbed["trace.trace"]!)).toBe(`${snapshot("[redacted]")}\n`);
    expect(strFromU8(scrubbed["resources/0c35.json"]!)).toBe('{"account":"[redacted]","sentAt":1731234567890}');
    expect(strFromU8(scrubbed["resources/e160.html"]!)).toBe('<div id="account">[redacted]</div>');
  });

  it("copies binary entries unchanged", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]);
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register(OTP);
    const zip = zipSync({
      "resources/0b1f.png": png,
      "trace.trace": strToU8(`{"type":"log","message":"fill(\\"${OTP}\\")","time":7391506.2}\n`),
    });

    const scrubbed = unzipSync(scrubTrace(zip, redactor));

    expect(scrubbed["resources/0b1f.png"]).toEqual(png);
    expect(strFromU8(scrubbed["trace.trace"]!)).toBe(
      '{"type":"log","message":"fill(\\"[redacted]\\")","time":7391506.2}\n',
    );
  });

  it("masks a JSON number that is a registered value and keeps numbers that only contain one", () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register("739150");
    const zip = zipSync({ "resources/5c2e.json": strToU8('{"code":739150,"sentAt":7391506.2}') });

    const scrubbed = unzipSync(scrubTrace(zip, redactor));

    expect(strFromU8(scrubbed["resources/5c2e.json"]!)).toBe('{"code":"[redacted]","sentAt":7391506.2}');
  });

  it("masks a JSON number that is a registered value without its leading zeros and keeps a timestamp that contains it", () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register("012345");
    // a page that posts the OTP as a JSON number, as Playwright stores the request body
    const zip = zipSync({ "resources/9a4d.json": strToU8('{"code":12345,"sentAt":7123450.2}') });

    const scrubbed = unzipSync(scrubTrace(zip, redactor));

    expect(strFromU8(scrubbed["resources/9a4d.json"]!)).toBe('{"code":"[redacted]","sentAt":7123450.2}');
  });

  it("masks a registered number inside a JSON body held as a string and keeps an unrelated JSON string as it was", () => {
    const redactor = new Redactor(defaultRedactionRules());
    redactor.register("012345");
    // how Playwright records a JSON body posted as application/x-www-form-urlencoded: the body is a params name
    const request = (params: { name: string; value: string }[]) =>
      JSON.stringify({
        type: "resource-snapshot",
        snapshot: {
          request: { method: "POST", postData: { mimeType: "application/x-www-form-urlencoded", text: "", params } },
        },
      });
    const unrelated = { name: '{ "sentAt": 7123450.2, "page": [1, 2] }', value: "" };
    const zip = zipSync({
      "trace.network": strToU8(
        `${request([{ name: '{"code":12345}', value: "" }, unrelated])}\n${request([unrelated])}\n`,
      ),
    });

    const scrubbed = unzipSync(scrubTrace(zip, redactor));

    expect(strFromU8(scrubbed["trace.network"]!)).toBe(
      `${request([{ name: '{"code":"[redacted]"}', value: "" }, unrelated])}\n${request([unrelated])}\n`,
    );
  });

  it("attaches no trace when scrubbing fails", async () => {
    const root = await tempDir();
    const env = demoEnv();
    // the session's redactor scrubs traces; the evidence keeps its own working one
    const failing = new Redactor(defaultRedactionRules());
    vi.spyOn(failing, "maskRegistered").mockImplementation(() => {
      throw new Error("cannot read this trace");
    });
    const scratch = join(root, "tmp");
    await mkdir(scratch);
    try {
      const session = await launch("chromium", { env, runDir: join(root, "runs"), redactor: failing });
      const evidence = newEvidence(join(root, "runs"), "WEB-TRACE-001");
      const note = vi.spyOn(evidence, "note");
      await runSteps(stepContext(session, { env, evidence, root }), [{ open: `${site.origin}/` }]);
      // only the trace's temporary file lands in scratch; the browser made its own folders at launch
      vi.stubEnv("TMPDIR", scratch);

      await session.close({ status: "fail", evidence });

      await expect(readdir(join(root, "runs", "WEB-TRACE-001"))).rejects.toThrow(/ENOENT/);
      expect(note.mock.calls).toEqual([["trace.zip was left out: cannot read this trace"]]);
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
