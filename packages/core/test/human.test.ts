import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  answersFileChannel,
  oneAtATime,
  parseVerdict,
  terminalChannel,
  type HumanChannel,
  type PersonAnswer,
  type PersonPrompt,
} from "../src/challenge/index.ts";

const RUN_ID = "20261106-093000-a1b2";
const signal = new AbortController().signal;

function prompt(overrides: Partial<PersonPrompt> = {}): PersonPrompt {
  return {
    id: "AUTH-PIN-001-4-guided",
    runId: RUN_ID,
    caseId: "AUTH-PIN-001",
    ask: "verdict",
    title: "Log in with MPIN and face verification",
    steps: ["Choose MPIN, enter it", "Complete the face check"],
    expected: "Dashboard with holdings",
    screenshot: `runs/${RUN_ID}/AUTH-PIN-001/03-login.png`,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("parseVerdict", () => {
  it.each([
    ["p looks right", "pass"],
    ["pass looks right", "pass"],
    ["F looks right", "fail"],
    ["fail looks right", "fail"],
    ["b looks right", "blocked"],
    ["  Blocked   looks right ", "blocked"],
  ] as const)("parses p, pass, f, fail, b, blocked with a note: %s", (line, verdict) => {
    expect(parseVerdict(line)).toEqual({ kind: "verdict", verdict, note: "looks right" });
  });

  it("keeps the note empty when none follows the verdict", () => {
    expect(parseVerdict("p")).toEqual({ kind: "verdict", verdict: "pass", note: "" });
  });

  it.each(["", "passed", "maybe", "x pass"])("returns null for a line that is not a verdict: %j", (line) => {
    expect(parseVerdict(line)).toBeNull();
  });
});

describe("terminalChannel", () => {
  function terminal(): { input: PassThrough; printed: () => string; channel: ReturnType<typeof terminalChannel> } {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    return { input, printed: () => chunks.join(""), channel: terminalChannel({ input, output }) };
  }

  it("shows the steps, expected result and screenshot path, and asks again until a verdict", async () => {
    const { input, printed, channel } = terminal();
    input.write("not sure\np holdings shown\n");

    const answer = await channel.ask(prompt(), signal);

    expect(answer).toEqual({ kind: "verdict", verdict: "pass", note: "holdings shown" });
    const text = printed();
    expect(text).toContain("AUTH-PIN-001: Log in with MPIN and face verification");
    expect(text).toContain("  1. Choose MPIN, enter it\n  2. Complete the face check");
    expect(text).toContain("Expected: Dashboard with holdings");
    expect(text).toContain(`Screenshot: runs/${RUN_ID}/AUTH-PIN-001/03-login.png`);
    expect(text.split("Result? p (pass)").length - 1).toBe(2);
  });

  it("reads a value for a value prompt and d for an action prompt", async () => {
    const { input, channel } = terminal();

    input.write("123456\n");
    expect(await channel.ask(prompt({ ask: "value" }), signal)).toEqual({ kind: "value", value: "123456" });
    input.write("d\n");
    expect(await channel.ask(prompt({ ask: "action" }), signal)).toEqual({ kind: "done" });
  });

  it("keeps the lines that arrive together for the asks that follow", async () => {
    const { input, channel } = terminal();
    input.write("123456\nd\n");

    expect(await channel.ask(prompt({ ask: "value" }), signal)).toEqual({ kind: "value", value: "123456" });
    expect(await channel.ask(prompt({ ask: "action", timeoutMs: 200 }), signal)).toEqual({ kind: "done" });
  });

  it("answers timeout when no line arrives in time", async () => {
    const { channel } = terminal();

    expect(await channel.ask(prompt({ timeoutMs: 30 }), signal)).toEqual({ kind: "timeout" });
  });
});

describe("oneAtATime", () => {
  /** Answers done `afterMs` after each prompt is shown, and records when prompts were shown and answered. */
  function person(afterMs: number): HumanChannel & { events: string[] } {
    const events: string[] = [];
    return {
      events,
      async ask(shown, abort) {
        events.push(`shown ${shown.id}`);
        await sleep(afterMs, undefined, { signal: abort });
        events.push(`answered ${shown.id}`);
        return { kind: "done" };
      },
    };
  }

  it("shows one prompt at a time, in the order asked, also when wrapped twice", async () => {
    const channel = person(50);
    const queued = oneAtATime(oneAtATime(channel));

    await Promise.all([queued.ask(prompt({ id: "A-1" }), signal), queued.ask(prompt({ id: "B-1" }), signal)]);

    expect(channel.events).toEqual(["shown A-1", "answered A-1", "shown B-1", "answered B-1"]);
  });

  it("starts the window of a prompt asked through a second wrap only when the prompt is shown", async () => {
    const channel = person(200);
    const queued = oneAtATime(channel);

    // the second prompt waits 200 ms for the first, then needs 200 ms of its 300 ms window
    const answers = await Promise.all([
      queued.ask(prompt({ id: "A-1", timeoutMs: 1_000 }), signal),
      oneAtATime(queued).ask(prompt({ id: "B-1", timeoutMs: 300 }), signal),
    ]);

    expect(answers).toEqual([{ kind: "done" }, { kind: "done" }]);
    expect(channel.events).toEqual(["shown A-1", "answered A-1", "shown B-1", "answered B-1"]);
  });
});

describe("answersFileChannel", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "human-test-")), RUN_ID);
  });

  afterEach(async () => {
    await rm(dirname(runDir), { recursive: true, force: true });
  });

  // answerers put the file in place with a rename, as the channel requires
  async function writeAnswer(id: string, answer: unknown): Promise<void> {
    await mkdir(join(runDir, "answers"), { recursive: true });
    const file = join(runDir, "answers", `${id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(answer));
    await rename(`${file}.tmp`, file);
  }

  async function waitForFile(file: string): Promise<string> {
    for (let tries = 0; tries < 200; tries++) {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text !== undefined) return text;
      await sleep(5);
    }
    throw new Error(`${file} never appeared`);
  }

  it("answers file is claimed, read once and deleted", async () => {
    const asked = prompt();
    const answering = answersFileChannel(runDir, { pollMs: 5 }).ask(asked, signal);

    const written = await waitForFile(join(runDir, "prompts", `${asked.id}.json`));
    expect(JSON.parse(written)).toEqual(asked);
    await writeAnswer(asked.id, { kind: "verdict", verdict: "fail", note: "face check looped" });

    expect(await answering).toEqual({ kind: "verdict", verdict: "fail", note: "face check looped" });
    expect(await readdir(join(runDir, "answers"))).toEqual([]);
    expect(await readdir(join(runDir, "prompts"))).toEqual(["done"]);
    expect(await readdir(join(runDir, "prompts", "done"))).toEqual([`${asked.id}.json`]);
  });

  it("two claimers racing on one answer file give exactly one winner", async () => {
    const asked = prompt({ ask: "value", timeoutMs: 300 });
    await writeAnswer(asked.id, { kind: "value", value: "123456" });

    const answers = await Promise.all(
      Array.from({ length: 8 }, () => answersFileChannel(runDir, { pollMs: 1 }).ask(asked, signal)),
    );

    const winners = answers.filter((answer: PersonAnswer) => answer.kind === "value");
    expect(winners).toEqual([{ kind: "value", value: "123456" }]);
    expect(answers.filter((answer) => answer.kind === "timeout")).toHaveLength(7);
    expect(await readdir(join(runDir, "answers"))).toEqual([]);
  });

  it("timeout answer when nobody answers in time, and the prompt leaves the pending list", async () => {
    const asked = prompt({ timeoutMs: 20 });

    expect(await answersFileChannel(runDir, { pollMs: 5 }).ask(asked, signal)).toEqual({ kind: "timeout" });
    expect(await readdir(join(runDir, "prompts", "done"))).toEqual([`${asked.id}.json`]);
  });

  it("consumes an answer file that is not an answer and names the prompt", async () => {
    const asked = prompt();
    await writeAnswer(asked.id, { kind: "maybe" });

    await expect(answersFileChannel(runDir, { pollMs: 5 }).ask(asked, signal)).rejects.toThrow(
      `answer to prompt ${asked.id} is not an answer`,
    );
    expect(await readdir(join(runDir, "answers"))).toEqual([]);
  });

  it("refuses a prompt id that is not a plain file name", async () => {
    await expect(answersFileChannel(runDir).ask(prompt({ id: "../escape" }), signal)).rejects.toThrow(
      'prompt id "../escape" is not a plain file name',
    );
  });
});
