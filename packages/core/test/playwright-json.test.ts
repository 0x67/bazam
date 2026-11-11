import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ResultParseError, type ExternalTest } from "../src/ingest/format.ts";
import { playwrightJsonFormat } from "../src/ingest/playwright.ts";

const REPORT = fileURLToPath(new URL("./fixtures/results/playwright.json", import.meta.url));
const INLINE = "results/report.json";
const MARKER = "marker-7f3a";

async function parseReport(): Promise<ExternalTest[]> {
  return playwrightJsonFormat.parse({ path: REPORT, text: await readFile(REPORT, "utf8") });
}

function find(
  tests: readonly ExternalTest[],
  project: string,
  id: string,
): ExternalTest | undefined {
  return tests.find((test) => test.project === project && test.title.at(-1)?.includes(`[${id}]`));
}

describe("playwrightJsonFormat", () => {
  it("gives one test per project, titled by the file suite, its describes and the spec", async () => {
    const tests = await parseReport();

    expect(
      tests.map((test) => [test.project, test.title.join(" › "), test.outcome, test.retries]),
    ).toEqual([
      [
        "chromium",
        "auth/login.spec.ts › login › signs in with an email code [AUTH-LOGIN-001]",
        "passed",
        0,
      ],
      [
        "firefox",
        "auth/login.spec.ts › login › signs in with an email code [AUTH-LOGIN-001]",
        "passed",
        0,
      ],
      [
        "chromium",
        "auth/login.spec.ts › login › keeps the session after reload [AUTH-LOGIN-002]",
        "passed",
        1,
      ],
      [
        "firefox",
        "auth/login.spec.ts › login › keeps the session after reload [AUTH-LOGIN-002]",
        "passed",
        0,
      ],
      ["chromium", "auth/login.spec.ts › login › signs out [AUTH-LOGIN-004]", "failed", 1],
      ["firefox", "auth/login.spec.ts › login › signs out [AUTH-LOGIN-004]", "failed", 1],
      [
        "chromium",
        "auth/login.spec.ts › login › resets the password [AUTH-LOGIN-005]",
        "skipped",
        0,
      ],
      [
        "firefox",
        "auth/login.spec.ts › login › resets the password [AUTH-LOGIN-005]",
        "skipped",
        0,
      ],
      [
        "chromium",
        "auth/login.spec.ts › login › lockout › locks after five tries [AUTH-LOGIN-003]",
        "failed",
        1,
      ],
      [
        "firefox",
        "auth/login.spec.ts › login › lockout › locks after five tries [AUTH-LOGIN-003]",
        "failed",
        1,
      ],
      ["chromium", "home.spec.ts › home page loads [WEB-HOME-001]", "passed", 0],
      ["firefox", "home.spec.ts › home page loads [WEB-HOME-001]", "passed", 0],
    ]);
    expect(tests.every((test) => test.source === REPORT)).toBe(true);
  });

  it("keeps the last result's attachments that have a path, absolute as the reporter wrote them", async () => {
    const signIn = find(await parseReport(), "chromium", "AUTH-LOGIN-001");

    expect(signIn?.attachments).toEqual([
      {
        name: "inbox",
        path: "/home/ci/shop-web/test-results/auth-login-login-signs-in-with-an-email-code-AUTH-LOGIN-001--chromium/attachments/inbox-53bcbe78812fcbf91e126efc726f7ad521ad9e9f.txt",
        contentType: "text/plain",
      },
    ]);
    expect(signIn?.tags).toEqual(["smoke"]);
  });

  it("takes the message and the duration from the last result, without ANSI codes", async () => {
    const lockout = find(await parseReport(), "chromium", "AUTH-LOGIN-003");

    expect(lockout?.message).toMatch(
      /^Error: expect\(received\)\.toBe\(expected\) \/\/ Object\.is equality\n\nExpected: 5\nReceived: 1\n/,
    );
    expect(lockout?.message).not.toContain("\u001b");
    expect(lockout?.durationMs).toBe(3);
  });

  it("reads a test of an unnamed project that expected to be skipped and has no results", async () => {
    const test = { projectName: "", expectedStatus: "skipped", status: "expected", results: [] };
    const text = JSON.stringify({
      suites: [{ title: "cart.spec.ts", specs: [{ title: "pays", tags: [], tests: [test] }] }],
    });

    expect(await playwrightJsonFormat.parse({ path: INLINE, text })).toEqual([
      {
        title: ["cart.spec.ts", "pays"],
        tags: [],
        outcome: "skipped",
        retries: 0,
        attachments: [],
        source: INLINE,
      },
    ]);
  });

  it.each([
    [
      "a syntax error V8 gives a position for",
      `{"suites": [\n  {"title": "${MARKER}",}\n]}`,
      `${INLINE}: not valid JSON (line 2, column 27)`,
    ],
    ["a syntax error V8 quotes the input for", MARKER, `${INLINE}: not valid JSON`],
    ["JSON without a suites array", `{"${MARKER}": []}`, `${INLINE}: not a Playwright JSON report`],
  ])(
    "throws ResultParseError for %s, naming the file and quoting none of it",
    async (_, text, message) => {
      const failure: unknown = await playwrightJsonFormat
        .parse({ path: INLINE, text })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ResultParseError);
      expect((failure as ResultParseError).message).toBe(message);
      expect((failure as ResultParseError).message).not.toContain(MARKER);
      expect((failure as ResultParseError).message).not.toContain("\n");
    },
  );
});
