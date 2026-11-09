/**
 * Stands in for an external test suite that writes JUnit XML. The arguments name the variables that hold the
 * selected case ids, the challenge service URL and its token, then any more variables to report. SUITE_* variables
 * from the runner and target env choose what it does.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [casesVar = "", urlVar = "", tokenVar = ""] = process.argv.slice(2);
const env = process.env;
const list = (value: string | undefined): string[] => (value ?? "").split(",").filter((item) => item !== "");
const ids = list(env[casesVar]);

function noteSignal(name: string): void {
  if (env["SUITE_SIGNAL_FILE"] !== undefined) appendFileSync(env["SUITE_SIGNAL_FILE"], `${name}\n`);
}

process.on("SIGINT", () => {
  noteSignal("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  noteSignal("SIGTERM");
  // a suite that ignores SIGTERM stops only on SIGKILL
  if (env["SUITE_IGNORE_TERM"] === undefined) process.exit(143);
});

function mark(event: string): void {
  if (env["SUITE_LOG"] !== undefined) appendFileSync(env["SUITE_LOG"], `${env["SUITE_NAME"] ?? "suite"} ${event}\n`);
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

/** Asks the challenge service for an otp-email code for the case; the answer itself is never written. */
async function ask(caseId: string): Promise<string | undefined> {
  const response = await fetch(env[urlVar] ?? "", {
    method: "POST",
    headers: { authorization: `Bearer ${env[tokenVar] ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "otp-email", caseId }),
  });
  const body = (await response.json()) as { value?: string; error?: string };
  return response.status === 200 && body.value !== undefined ? undefined : `service answered ${response.status}`;
}

mark("start");
if (env["SUITE_URL_FILE"] !== undefined) writeFileSync(env["SUITE_URL_FILE"], env[urlVar] ?? "");
if (env["SUITE_REPORT"] !== undefined) {
  const names = process.argv.slice(2);
  writeFileSync(env["SUITE_REPORT"], JSON.stringify(Object.fromEntries(names.map((name) => [name, env[name] ?? null]))));
}
if (env["SUITE_PRINT_VAR"] !== undefined) console.log(`value of ${env["SUITE_PRINT_VAR"]}: ${env[env["SUITE_PRINT_VAR"]]}`);
const askFailure = env["SUITE_ASK"] === undefined ? undefined : await ask(env["SUITE_ASK"]);
if (env["SUITE_HOLD_MS"] !== undefined) await sleep(Number(env["SUITE_HOLD_MS"]));
const waitFor = env["SUITE_WAIT_FOR"];
for (let tries = 0; waitFor !== undefined && !existsSync(waitFor); tries += 1) {
  if (tries > 500) throw new Error(`${waitFor} did not appear`);
  await sleep(10);
}

if (env["SUITE_NO_RESULTS"] === undefined) {
  const failing = list(env["SUITE_FAIL"]);
  const written = env["SUITE_WRITE"] === undefined ? ids : list(env["SUITE_WRITE"]);
  const testcase = (name: string, failure?: string): string =>
    failure === undefined
      ? `  <testcase classname="Shop" name="${escape(name)}"/>`
      : `  <testcase classname="Shop" name="${escape(name)}"><failure message="${escape(failure)}"/></testcase>`;
  const cases = written.map((id) => {
    const failure = failing.includes(id) ? "expected the cart to hold 1 item" : id === env["SUITE_ASK"] ? askFailure : undefined;
    return testcase(`[${id}] works`, failure);
  });
  if (env["SUITE_UNMAPPED"] !== undefined) cases.push(testcase(env["SUITE_UNMAPPED"]));
  const xml = env["SUITE_GARBAGE"] === undefined ? `<testsuite name="shop">\n${cases.join("\n")}\n</testsuite>\n` : "<testsuite";
  const file = env["SUITE_RESULTS"] ?? "reports/results.xml";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, xml);
}
if (env["SUITE_HANG"] !== undefined) await sleep(60_000);
mark("end");
process.exitCode = Number(env["SUITE_EXIT"] ?? 0);
