import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ResultParseError, type ExternalTest, type TestOutcome } from "../src/ingest/format.ts";
import { junitFormat } from "../src/ingest/junit.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/results/${name}`, import.meta.url));
const INLINE = "results/junit.xml";
const MARKER = "marker-7f3a";

async function parseFixture(name: string): Promise<ExternalTest[]> {
  return junitFormat.parse({ path: fixture(name), text: await readFile(fixture(name), "utf8") });
}

function external(
  source: string,
  title: string[],
  outcome: TestOutcome,
  fields: Partial<ExternalTest> = {},
): ExternalTest {
  return { title, tags: [], outcome, retries: 0, attachments: [], source, ...fields };
}

describe("junitFormat", () => {
  it("reads a Surefire 3 report with a testsuite root and counts flaky and rerun children as retries", async () => {
    const source = fixture("surefire.xml");

    expect(await parseFixture("surefire.xml")).toEqual([
      external(source, ["com.shop.CartTest", "keepsItemsAfterSignIn"], "passed", { durationMs: 412 }),
      external(source, ["com.shop.CartTest", "mergesGuestCart"], "passed", { retries: 2, durationMs: 731 }),
      external(source, ["com.shop.CartTest", "removesItem"], "failed", {
        message: "java.lang.AssertionError",
        retries: 1,
        durationMs: 201,
      }),
      external(source, ["com.shop.CartTest", "checksStock"], "errored", {
        message: "Connection refused",
        durationMs: 4,
      }),
      external(source, ["com.shop.CartTest", "appliesCoupon"], "skipped", { durationMs: 0 }),
    ]);
  });

  it("reads a pytest xunit2 report: a setup error is errored and pytest.skip is skipped", async () => {
    const source = fixture("pytest.xml");

    expect(await parseFixture("pytest.xml")).toEqual([
      external(source, ["tests.test_orders", "test_lists_orders"], "passed", { durationMs: 12 }),
      external(source, ["tests.test_orders", "test_cancels_order"], "failed", {
        message: "AssertionError: assert 'open' == 'cancelled'\n  \n  - cancelled\n  + open",
        durationMs: 4,
      }),
      external(source, ["tests.test_orders", "test_refunds_order"], "errored", {
        message: 'failed on setup with "ConnectionError: payment sandbox unreachable"',
        durationMs: 1,
      }),
      external(source, ["tests.test_orders", "test_exports_csv"], "skipped", { durationMs: 0 }),
    ]);
  });

  it("reads the Playwright junit reporter: a thrown error is errored and attachment paths stay as written", async () => {
    const source = fixture("playwright-junit.xml");
    const tests = await parseFixture("playwright-junit.xml");

    expect(tests.map((test) => [test.title, test.outcome, test.message])).toEqual([
      [["auth/login.spec.ts", "login › signs in with an email code [AUTH-LOGIN-001]"], "passed", undefined],
      [["auth/login.spec.ts", "login › keeps the session after reload [AUTH-LOGIN-002]"], "passed", undefined],
      [
        ["auth/login.spec.ts", "login › lockout › locks after five tries [AUTH-LOGIN-003]"],
        "failed",
        "expect(received).toBe(expected) // Object.is equality",
      ],
      [["auth/login.spec.ts", "login › signs out [AUTH-LOGIN-004]"], "errored", "session store unavailable"],
      [["auth/login.spec.ts", "login › resets the password [AUTH-LOGIN-005]"], "skipped", undefined],
      [["home.spec.ts", "home page loads [WEB-HOME-001]"], "passed", undefined],
    ]);
    // relative to the XML file's folder, which the recorder resolves from the source
    expect(tests[0]?.attachments).toEqual([
      {
        name: "inbox-53bcbe78812fcbf91e126efc726f7ad521ad9e9f.txt",
        path: "../test-results/auth-login-login-signs-in-with-an-email-code-AUTH-LOGIN-001--chromium/attachments/inbox-53bcbe78812fcbf91e126efc726f7ad521ad9e9f.txt",
      },
    ]);
    expect(tests[3]?.attachments.map((attachment) => attachment.path)).toEqual([
      "../test-results/auth-login-login-signs-out-AUTH-LOGIN-004--chromium/error-context.md",
      "../test-results/auth-login-login-signs-out-AUTH-LOGIN-004--chromium-retry1/error-context.md",
    ]);
    expect(tests.every((test) => test.source === source)).toBe(true);
  });

  it("titles a mocha-junit-reporter test by its name, which holds the full title", async () => {
    const source = fixture("mocha.xml");
    const screenshot = "cart -- removes an item [SHOP-CART-003] (failed).png";

    expect(await parseFixture("mocha.xml")).toEqual([
      external(source, ["cart adds an item [SHOP-CART-002]"], "passed", { durationMs: 1102 }),
      external(source, ["cart removes an item [SHOP-CART-003]"], "failed", {
        message: "Timed out retrying after 4000ms: expected '<span.count>' to have text '0', but the text was '1'",
        durationMs: 2112,
        attachments: [{ name: screenshot, path: `/home/ci/shop/cypress/screenshots/cart.cy.ts/${screenshot}` }],
      }),
      external(source, ["cart shows the total [SHOP-CART-004]"], "skipped", { durationMs: 0 }),
    ]);
  });

  it("titles a Node test runner case by its enclosing describes, also when its name ends with test", async () => {
    const tests = await parseFixture("node.xml");

    expect(tests.map((test) => [test.title, test.outcome])).toEqual([
      [["health answers ok [DEMO-API-001]"], "passed"],
      [["checkout", "smoke test"], "passed"],
      [["checkout", "rejects an expired card [DEMO-PAY-002]"], "failed"],
      [["checkout", "refunds [DEMO-PAY-003]"], "skipped"],
      [["checkout", "splits a payment [DEMO-PAY-004]"], "skipped"],
      [["checkout", "vouchers", "applies a voucher [DEMO-PAY-005]"], "passed"],
    ]);
    expect(tests[5]?.durationMs).toBe(12);
  });

  it("parses a Node failure message written with raw ANSI codes and reads it as plain text", async () => {
    const text = await readFile(fixture("node.xml"), "utf8");
    const failed = (await parseFixture("node.xml"))[2];

    expect(text).toContain('message="boom \u001b[31mred\u001b[0m"');
    expect(failed?.outcome).toBe("failed");
    expect(failed?.message).toBe("boom red");
  });

  it("removes the characters XML 1.0 forbids and the character references to them", async () => {
    const text = `<testsuites><testcase classname="test" name="a&#x1B;b&#1;c\u0007d"><failure message="x&#xFFFF;y￾z"/></testcase></testsuites>`;

    expect(await junitFormat.parse({ path: INLINE, text })).toEqual([
      external(INLINE, ["abcd"], "failed", { message: "xyz" }),
    ]);
  });

  it("expands no entity, neither a DOCTYPE one nor an HTML name", async () => {
    const text = `<!DOCTYPE testsuites [<!ENTITY team "payments">]><testsuites><testcase classname="test" name="&team; &nbsp;checkout"/></testsuites>`;

    expect((await junitFormat.parse({ path: INLINE, text }))[0]?.title).toEqual(["&team; &nbsp;checkout"]);
  });

  it("reads a status attribute when a testcase has no outcome child", async () => {
    const text = `<testsuite name="Login"><testcase name="a" status="FAILED"/><testcase name="b" status="ERROR"/><testcase name="c" status="SKIPPED"/><testcase name="d" status="PASSED"/></testsuite>`;

    expect((await junitFormat.parse({ path: INLINE, text })).map((test) => [test.title, test.outcome])).toEqual([
      [["Login", "a"], "failed"],
      [["Login", "b"], "errored"],
      [["Login", "c"], "skipped"],
      [["Login", "d"], "passed"],
    ]);
  });

  it("reads a testcase under a wrapper element that is not a testsuite", async () => {
    const text = `<testsuites><group><testcase name="a" classname="c"/></group></testsuites>`;

    expect(await junitFormat.parse({ path: INLINE, text })).toEqual([external(INLINE, ["c", "a"], "passed")]);
  });

  it.each([
    [
      "an element left open",
      `<testsuites><testsuite name="${MARKER}"><testcase name="a"></testsuite></testsuites>`,
      `${INLINE}: Missing end tag for element testcase (line 1, column 62)`,
    ],
    [
      "a bare ampersand in text",
      `<testsuites>\n<testcase name="a"><failure>${MARKER} & more</failure></testcase>\n</testsuites>`,
      `${INLINE}: Unterminated reference (a reference must end with \`;\`) (line 2, column 43)`,
    ],
    [
      "a root that is neither testsuites nor testsuite",
      `<html><body title="${MARKER}">${MARKER}</body></html>`,
      `${INLINE}: the root element is neither testsuites nor testsuite`,
    ],
  ])("throws ResultParseError for %s, naming the file and quoting none of it", async (_, text, message) => {
    const failure: unknown = await junitFormat.parse({ path: INLINE, text }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ResultParseError);
    expect((failure as ResultParseError).message).toBe(message);
    expect((failure as ResultParseError).message).not.toContain(MARKER);
    expect((failure as ResultParseError).message).not.toContain("\n");
  });
});
