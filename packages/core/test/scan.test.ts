import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CaseResult } from "../src/result/index.ts";
import { scanFiles, withheldAttachments, type ScanValues } from "../src/scan/index.ts";

const RUN_ID = "20261107-101500-0a1b";
const AROUND = Date.UTC(2026, 10, 7, 10, 15, 0);
const PHONE_NATIONAL = "7700900123";
const JSON_SECRET = 'pa"ss-word-4417';
const PERCENT_SECRET = "a b&c=d-secret";
const CREDENTIAL = "fake-session-token-4417";
const ACCOUNT_DIGITS = "4400123456";

const values: ScanValues = {
  values: [
    { kind: "fixture alice.phone", value: PHONE_NATIONAL },
    { kind: "secret DEMO_QUOTED", value: JSON_SECRET },
    { kind: "secret DEMO_SPACED", value: PERCENT_SECRET },
    { kind: "credential ops/web", value: CREDENTIAL },
  ],
  skipped: ["secret DEMO_GONE was not read"],
  around: AROUND,
};
const RAW_VALUES = [
  PHONE_NATIONAL,
  JSON_SECRET,
  JSON.stringify(JSON_SECRET).slice(1, -1),
  PERCENT_SECRET,
  encodeURIComponent(PERCENT_SECRET),
  CREDENTIAL,
  ACCOUNT_DIGITS,
  "carol@",
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scan-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), content);
}

const text = (content: string) => new TextEncoder().encode(content);

describe("scanFiles", () => {
  it("reports each kind by file and zip entry, and no context holds a value", async () => {
    await put("case/trace.zip", zipSync({ "trace.trace": text(`{"typed":"${PHONE_NATIONAL}"}`) }));
    await put("case/nested.zip", zipSync({ "inner.zip": zipSync({ "a.txt": text(`token ${CREDENTIAL} sent`) }) }));
    await put("case/run.log", `quoted ${JSON.stringify(JSON_SECRET)} and ${encodeURIComponent(PERCENT_SECRET)} end\n`);
    await put("case/mail.log", "reply to carol@corp.invalid or alice@example.test\n");
    await put("case/account.log", `account ${ACCOUNT_DIGITS} was charged\n`);

    const report = await scanFiles(
      dir,
      ["case/trace.zip", "case/nested.zip", "case/run.log", "case/mail.log", "case/account.log"],
      values,
    );

    const found = report.findings.map(({ kind, file }) => `${file} ${kind}`).toSorted();
    expect(found).toEqual([
      "case/account.log digits",
      "case/mail.log email",
      "case/nested.zip:inner.zip:a.txt credential ops/web",
      "case/run.log secret DEMO_QUOTED",
      "case/run.log secret DEMO_SPACED",
      "case/trace.zip:trace.trace fixture alice.phone",
    ]);
    const contexts = report.findings.map((finding) => finding.context);
    expect(contexts).toContain('{"typed":"[fixture alice.phone]"}');
    expect(contexts).toContain("account <10 digits, ends 3456> was charged ");
    for (const context of contexts) for (const raw of RAW_VALUES) expect(context).not.toContain(raw);
    expect(report.files).toBe(5);
    expect(report.skipped).toEqual(["secret DEMO_GONE was not read"]);
  });

  it("leaves out run ids, times near the run's start and png files", async () => {
    const epochMs = String(AROUND + 60_000);
    const epochSeconds = String(Math.floor(AROUND / 1000) + 60);
    await put("case/times.log", `${RUN_ID} ${epochMs} ${epochSeconds} 20261108 on ${PHONE_NATIONAL.slice(0, 3)}\n`);
    await put("case/shot.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(CREDENTIAL)]));

    const report = await scanFiles(dir, ["case/times.log", "case/shot.png"], values);

    expect(report.findings).toEqual([]);
    expect(report.files).toBe(1);
  });

  it("scans result.json without the harness fields", async () => {
    const result = { notes: [], seed: 7, durationMs: 1234567890, values: { phone: PHONE_NATIONAL } };
    await put("case/result.json", JSON.stringify(result));
    await put("case/other.json", JSON.stringify(result));

    const report = await scanFiles(dir, ["case/result.json", "case/other.json"], values);

    expect(report.findings.map((finding) => finding.file)).toEqual(["case/other.json", "case/other.json"]);
  });

  it("masks a short value behind an escape in the context of a nearby finding", async () => {
    const pin: ScanValues = { ...values, values: [...values.values, { kind: "fixture alice.pin", value: "4821" }] };
    await put("case/a.log", `{"acct":"${ACCOUNT_DIGITS}\\n4821"}\n`);
    await put("case/b.log", `phone ${PHONE_NATIONAL} pin%3D4821\n`);

    const report = await scanFiles(dir, ["case/a.log", "case/b.log"], pin);

    expect(report.findings.length).toBeGreaterThan(0);
    for (const { context } of report.findings) expect(context).not.toContain("4821");
  });

  it("does not report digits that sit inside an id, a name or a float", async () => {
    await put(
      "case/trace.log",
      [
        "resources/abc12345678def0123456789abcdef01234567.png",
        "page@12345678abcd1234",
        "ratio 0.123456789012",
        `account ${ACCOUNT_DIGITS}`,
      ].join("\n"),
    );

    const report = await scanFiles(dir, ["case/trace.log"], values);

    expect(report.findings.map(({ kind }) => kind)).toEqual(["digits"]);
  });

  it("leaves a png entry of a zip unscanned", async () => {
    const pin: ScanValues = { ...values, values: [{ kind: "fixture alice.pin", value: "4821" }] };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(" 4821 ")]);
    await put("case/shots.zip", zipSync({ "frame.png": png, "note.txt": text("nothing here") }));

    const report = await scanFiles(dir, ["case/shots.zip"], pin);

    expect(report.findings).toEqual([]);
  });

  it("shows no tail of two values that overlap", async () => {
    const overlap: ScanValues = {
      ...values,
      values: [
        { kind: "fixture alice.first", value: "alpha-beta-gamma" },
        { kind: "fixture alice.second", value: "beta-gamma-delta" },
      ],
    };
    await put("case/o.log", "see alpha-beta-gamma-delta here\n");

    const report = await scanFiles(dir, ["case/o.log"], overlap);

    expect(report.findings.length).toBeGreaterThan(0);
    for (const { context } of report.findings) expect(context).not.toContain("delta");
  });

  it("lists a zip that does not unzip as skipped", async () => {
    await put("case/broken.zip", Buffer.from("PK\x03\x04 not a zip"));

    const report = await scanFiles(dir, ["case/broken.zip"], { ...values, skipped: [] });

    expect(report.findings).toEqual([]);
    expect(report.skipped).toEqual(["case/broken.zip is not a readable zip"]);
  });
});

describe("withheldAttachments", () => {
  it("lists only the attachments that hold a fixture, secret or credential value", async () => {
    await put("case-a/trace.zip", zipSync({ "trace.trace": text(`typed ${PHONE_NATIONAL} and ${CREDENTIAL}`) }));
    await put("case-a/mail.log", "reply to carol@corp.invalid\n");
    await put("case-a/account.log", `account ${ACCOUNT_DIGITS}\n`);
    await put("case-a/clean.log", "nothing here\n");
    const results = [
      { caseId: "case-a", attachments: ["trace.zip", "mail.log", "account.log", "clean.log"] } as CaseResult,
    ];

    const withheld = await withheldAttachments(dir, results, values);

    expect([...withheld]).toEqual([["case-a/trace.zip", ["credential ops/web", "fixture alice.phone"]]]);
  });
});
