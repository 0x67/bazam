import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CaseResult } from "../src/result/index.ts";
import { omittedAttachments, screenAttachments, type ScanValues } from "../src/scan/index.ts";

const PHONE_NATIONAL = "7700900123";
const CREDENTIAL = "fake-session-token-4417";
const ACCOUNT_DIGITS = "4400123456";

const values: ScanValues = {
  values: [
    { kind: "fixture alice.phone", value: PHONE_NATIONAL },
    { kind: "credential ops/web", value: CREDENTIAL },
  ],
  skipped: [],
  around: Date.UTC(2026, 10, 7, 10, 15, 0),
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "attachments-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), content);
}

const resultOf = (...attachments: string[]) =>
  [{ caseId: "case-a", attachments }] as unknown as CaseResult[];

describe("omittedAttachments", () => {
  it("never reaches a file through a name that is not plain", async () => {
    // a readable file sits where each bad name points
    await put("case-a/../x.png", "png");
    await put("a/b.png", "png");
    await put("case-a/a/b.png", "png");
    await put("case-a/.hidden", "text");
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "text");
    const names = ["../x.png", outside, "a/b.png", "", ".hidden"];

    const omitted = await omittedAttachments(dir, resultOf(...names));

    expect([...omitted]).toEqual(
      names.map((name) => [`case-a/${name}`, "outside the case folder"]),
    );
  });

  it("keeps a plain name for a file that is there", async () => {
    await put("case-a/01-shot.png", "png");

    expect([...(await omittedAttachments(dir, resultOf("01-shot.png")))]).toEqual([]);
  });

  it("calls a plain name with no file, or with a directory, missing", async () => {
    await mkdir(join(dir, "case-a", "02-folder"), { recursive: true });

    const omitted = await omittedAttachments(dir, resultOf("01-gone.zip", "02-folder"));

    expect([...omitted]).toEqual([
      ["case-a/01-gone.zip", "missing"],
      ["case-a/02-folder", "missing"],
    ]);
  });

  it.skipIf(process.platform === "win32")("never follows a link in the case folder", async () => {
    const outside = join(dir, "outside.txt");
    await writeFile(outside, CREDENTIAL);
    await mkdir(join(dir, "case-a"), { recursive: true });
    await symlink(outside, join(dir, "case-a", "01-link.txt"));

    const screen = await screenAttachments(dir, resultOf("01-link.txt"), values);

    expect([...screen.omitted]).toEqual([["case-a/01-link.txt", "outside the case folder"]]);
    expect([...screen.withheld]).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws a stat error that is not ENOENT",
    async () => {
      await put("case-a/01-shot.png", "png");
      await chmod(join(dir, "case-a"), 0o000);
      try {
        await expect(omittedAttachments(dir, resultOf("01-shot.png"))).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(join(dir, "case-a"), 0o700);
      }
    },
  );
});

describe("screenAttachments", () => {
  it("lists only the kept attachments that hold a fixture, secret or credential value", async () => {
    await put(
      "case-a/trace.zip",
      zipSync({
        "trace.trace": new TextEncoder().encode(`typed ${PHONE_NATIONAL} and ${CREDENTIAL}`),
      }),
    );
    await put("case-a/mail.log", "reply to carol@corp.invalid\n");
    await put("case-a/account.log", `account ${ACCOUNT_DIGITS}\n`);
    await put("case-a/clean.log", "nothing here\n");

    const { withheld, omitted } = await screenAttachments(
      dir,
      resultOf("trace.zip", "mail.log", "account.log", "clean.log"),
      values,
    );

    expect([...withheld]).toEqual([
      ["case-a/trace.zip", ["credential ops/web", "fixture alice.phone"]],
    ]);
    expect([...omitted]).toEqual([]);
  });

  it("scans no omitted attachment", async () => {
    // a secret sits where the bad name points; a scan that opened it would withhold it
    await put("x.log", `typed ${CREDENTIAL}`);

    const { withheld, omitted } = await screenAttachments(
      dir,
      resultOf("../x.log", "01-gone.log"),
      values,
    );

    expect([...withheld]).toEqual([]);
    expect([...omitted]).toEqual([
      ["case-a/../x.log", "outside the case folder"],
      ["case-a/01-gone.log", "missing"],
    ]);
  });
});
