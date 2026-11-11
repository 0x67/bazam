import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export interface PersonPrompt {
  /** Also the file name of the prompt and its answer in a run directory. */
  id: string;
  runId: string;
  caseId: string;
  ask: "action" | "value" | "verdict";
  title: string;
  steps: string[];
  expected?: string;
  /** Path of the latest screenshot. */
  screenshot?: string;
  timeoutMs: number;
}

export type PersonAnswer =
  | { kind: "verdict"; verdict: "pass" | "fail" | "blocked"; note: string }
  | { kind: "value"; value: string }
  | { kind: "done" }
  | { kind: "timeout" };

type VerdictAnswer = Extract<PersonAnswer, { kind: "verdict" }>;

export interface HumanChannel {
  ask(prompt: PersonPrompt, signal: AbortSignal): Promise<PersonAnswer>;
}

// the channels oneAtATime returned, so wrapping one again keeps its single queue
const queuedChannels = new WeakSet<HumanChannel>();

/**
 * Shows the person one prompt at a time, in the order asked, and starts each prompt's window when it is
 * shown. A channel that `oneAtATime` returned comes back unchanged.
 */
export function oneAtATime(channel: HumanChannel): HumanChannel {
  if (queuedChannels.has(channel)) return channel;
  const queue = new PersonQueue();
  const queued: HumanChannel = {
    async ask(prompt, signal) {
      const done = await queue.turn(signal);
      // also bounds a channel that does not keep the prompt's window itself
      const window = AbortSignal.timeout(prompt.timeoutMs);
      try {
        return await channel.ask(prompt, AbortSignal.any([signal, window]));
      } catch (error) {
        if (!window.aborted || signal.aborted) throw error;
        return { kind: "timeout" };
      } finally {
        done();
      }
    },
  };
  queuedChannels.add(queued);
  return queued;
}

/**
 * Lets asks through one at a time, in the order they came: terminalChannel cannot tell which open prompt a
 * typed line answers, and answersFileChannel names its files by prompt id, which two requests of one case,
 * kind and step share.
 */
class PersonQueue {
  #last: Promise<void> = Promise.resolve();

  /** Waits until every earlier ask has ended and returns the call that ends this one; rejects once `signal` aborts. */
  async turn(signal: AbortSignal): Promise<() => void> {
    const earlier = this.#last;
    const ended = Promise.withResolvers<void>();
    this.#last = earlier.then(() => ended.promise);
    try {
      await untilAborted(earlier, signal);
    } catch (error) {
      // the asks behind this one then wait only for the earlier ones
      ended.resolve();
      throw error;
    }
    return () => ended.resolve();
  }
}

/** Rejects with the signal's reason when it aborts first. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = (): void => aborted.reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Reads `p`, `pass`, `y` or `yes` as pass, `f`, `fail`, `n` or `no` as fail, and `b` or `blocked` as blocked, in any
 * case, with an optional note after a space.
 */
export function parseVerdict(line: string): VerdictAnswer | null {
  const match = /^\s*(p|pass|y|yes|f|fail|n|no|b|blocked)(?:\s+(.*))?$/i.exec(line);
  if (match === null) return null;
  const letter = match[1]!.charAt(0).toLowerCase();
  const verdict =
    letter === "p" || letter === "y"
      ? "pass"
      : letter === "f" || letter === "n"
        ? "fail"
        : "blocked";
  return { kind: "verdict", verdict, note: (match[2] ?? "").trim() };
}

const QUESTIONS: Record<PersonPrompt["ask"], string> = {
  verdict: "Result? p or y (pass), f or n (fail), or b (blocked), then an optional note: ",
  action: "Type d (done) when finished, or b (blocked) and an optional note: ",
  value: "Type the value, or b (blocked) and an optional note: ",
};

/**
 * Prints the prompt and reads lines until one answers it. One reader serves every ask, so lines that
 * arrive together, as piped or pasted answers do, each reach the ask that comes next.
 */
export function terminalChannel(io: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): HumanChannel {
  let lines: LineQueue | undefined;
  return {
    async ask(prompt, signal) {
      signal.throwIfAborted();
      lines ??= new LineQueue(io.input);
      io.output.write(`${promptText(prompt)}${QUESTIONS[prompt.ask]}`);
      const stop = AbortSignal.any([signal, AbortSignal.timeout(prompt.timeoutMs)]);
      for (let line = await lines.next(stop); line !== undefined; line = await lines.next(stop)) {
        const answer = parseLine(prompt.ask, line);
        if (answer !== null) return answer;
        io.output.write(QUESTIONS[prompt.ask]);
      }
      signal.throwIfAborted();
      if (stop.aborted) return { kind: "timeout" };
      throw new Error(`terminal input closed before prompt ${prompt.id} was answered`);
    },
  };
}

/** The lines of an input in order. Reading pauses while no ask waits, so the input does not keep the process alive. */
class LineQueue {
  readonly #reader: Interface;
  readonly #lines: string[] = [];
  #closed = false;
  #wake: (() => void) | undefined;

  constructor(input: NodeJS.ReadableStream) {
    this.#reader = createInterface({ input, crlfDelay: Infinity });
    this.#reader.on("line", (line) => {
      this.#lines.push(line);
      this.#wake?.();
    });
    this.#reader.on("close", () => {
      this.#closed = true;
      this.#wake?.();
    });
    this.#reader.pause();
  }

  /** Undefined once `signal` aborts, or once the input has closed and every line is taken. */
  async next(signal: AbortSignal): Promise<string | undefined> {
    while (this.#lines.length === 0 && !this.#closed && !signal.aborted) {
      const woken = Promise.withResolvers<void>();
      const wake = (): void => woken.resolve();
      this.#wake = wake;
      signal.addEventListener("abort", wake, { once: true });
      this.#reader.resume();
      try {
        await woken.promise;
      } finally {
        this.#reader.pause();
        this.#wake = undefined;
        signal.removeEventListener("abort", wake);
      }
    }
    return signal.aborted ? undefined : this.#lines.shift();
  }
}

function promptText(prompt: PersonPrompt): string {
  const lines = [
    "",
    `${prompt.caseId === "" ? "" : `${prompt.caseId}: `}${prompt.title}`,
    ...prompt.steps.map((step, index) => `  ${index + 1}. ${step}`),
  ];
  if (prompt.expected !== undefined) lines.push(`  Expected: ${prompt.expected}`);
  if (prompt.screenshot !== undefined) lines.push(`  Screenshot: ${prompt.screenshot}`);
  return `${lines.join("\n")}\n`;
}

function parseLine(ask: PersonPrompt["ask"], line: string): PersonAnswer | null {
  const verdict = parseVerdict(line);
  if (ask === "verdict") return verdict;
  if (verdict?.verdict === "blocked") return verdict;
  if (ask === "action") return /^\s*d(one)?\s*$/i.test(line) ? { kind: "done" } : null;
  const value = line.trim();
  return value === "" ? null : { kind: "value", value };
}

const AnswerFile = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("verdict"),
    verdict: z.enum(["pass", "fail", "blocked"]),
    note: z.string().default(""),
  }),
  z.strictObject({ kind: z.literal("value"), value: z.string() }),
  z.strictObject({ kind: z.literal("done") }),
]);

/**
 * Writes `prompts/<id>.json` under `runDir` and waits for `answers/<id>.json`. Whoever answers
 * must put that file in place with a rename, so a half-written answer is never claimed.
 * The answer is claimed by renaming it to `answers/<id>.claimed`, read once and deleted;
 * the prompt then moves to `prompts/done/`.
 */
export function answersFileChannel(
  runDir: string,
  options: { pollMs?: number } = {},
): HumanChannel {
  const pollMs = options.pollMs ?? 500;
  const promptsDir = join(runDir, "prompts");
  const answersDir = join(runDir, "answers");
  return {
    async ask(prompt, signal) {
      // the id becomes a file name, so it must not climb out of the run directory
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prompt.id))
        throw new Error(`prompt id "${prompt.id}" is not a plain file name`);
      signal.throwIfAborted();
      await mkdir(join(promptsDir, "done"), { recursive: true });
      await mkdir(answersDir, { recursive: true });
      const promptFile = join(promptsDir, `${prompt.id}.json`);
      const temporary = `${promptFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(prompt, null, 2)}\n`);
      await rename(temporary, promptFile);
      try {
        const deadline = Date.now() + prompt.timeoutMs;
        for (;;) {
          const answer = await claimAnswer(answersDir, prompt.id);
          if (answer !== undefined) return answer;
          const left = deadline - Date.now();
          if (left <= 0) return { kind: "timeout" };
          await sleep(Math.min(pollMs, left), undefined, { signal });
        }
      } finally {
        await rename(promptFile, join(promptsDir, "done", `${prompt.id}.json`)).catch(
          ignoreMissing,
        );
      }
    },
  };
}

async function claimAnswer(answersDir: string, id: string): Promise<PersonAnswer | undefined> {
  const claimed = join(answersDir, `${id}.claimed`);
  try {
    await rename(join(answersDir, `${id}.json`), claimed);
  } catch (error) {
    ignoreMissing(error);
    return undefined;
  }
  try {
    return parseAnswerFile(await readFile(claimed, "utf8"), id);
  } finally {
    await rm(claimed, { force: true });
  }
}

function parseAnswerFile(text: string, id: string): PersonAnswer {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // the parser's message quotes the text, which may hold a code
    throw new Error(`answer to prompt ${id} is not JSON`);
  }
  const parsed = AnswerFile.safeParse(json);
  if (!parsed.success)
    throw new Error(`answer to prompt ${id} is not an answer: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
