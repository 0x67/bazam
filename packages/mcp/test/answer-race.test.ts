import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PersonPrompt } from "@bazam/core/challenge";
import { RunSupervisor } from "../src/runs.ts";
import { CLI_PATH, fixtureProject, removeFixtures, type Fixture } from "./support/project.ts";

// the supervisor writes an answer through a rename, so a rename hook lands the run's moves between its checks
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

afterEach(async () => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  await removeFixtures();
});

const runId = "20261107-120000-abcd";
const promptId = "LOGIN-001-2-otp-email";
const prompt: PersonPrompt = {
  id: promptId,
  runId,
  caseId: "LOGIN-001",
  ask: "value",
  title: "Read the code",
  steps: [],
  timeoutMs: 1000,
};

/** A pending value prompt in a run whose process is this test's own, so the supervisor sees it alive. */
async function pending(): Promise<{
  project: Fixture;
  supervisor: RunSupervisor;
  answerFile: string;
}> {
  const project = await fixtureProject();
  const record = { runId, pid: process.pid, argv: [], startedAt: "2026-11-07T12:00:00.000Z" };
  await project.write(`runs/${runId}/supervisor.json`, JSON.stringify(record));
  await project.write(`runs/${runId}/prompts/${promptId}.json`, JSON.stringify(prompt));
  const answerFile = join(project.root, "runs", runId, "answers", `${promptId}.json`);
  return { project, supervisor: new RunSupervisor(project.root, CLI_PATH), answerFile };
}

/** Runs `before` just before the answer file lands and `after` just after. */
function aroundAnswer(
  answerFile: string,
  hooks: { before?: () => Promise<void>; after?: () => Promise<void> },
): void {
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (to !== answerFile) return actual.rename(from, to);
    await hooks.before?.();
    await actual.rename(from, to);
    await hooks.after?.();
  });
}

describe("an answer racing the run", () => {
  it("is taken back when the prompt times out before it lands", async () => {
    const { project, supervisor, answerFile } = await pending();
    const promptFile = join(project.root, "runs", runId, "prompts", `${promptId}.json`);
    // the channel's timeout moves the prompt to done/ and stops claiming answers
    aroundAnswer(answerFile, {
      before: async () => {
        await fs.mkdir(join(project.root, "runs", runId, "prompts", "done"));
        await actual.rename(
          promptFile,
          join(project.root, "runs", runId, "prompts", "done", `${promptId}.json`),
        );
      },
    });
    await expect(
      supervisor.answer(runId, promptId, { kind: "value", value: "834512" }),
    ).rejects.toThrow(`prompt ${promptId} is not pending in run ${runId}`);
    expect(existsSync(answerFile)).toBe(false);
  });

  it("is taken back when the run's process ends before it lands", async () => {
    const { project, supervisor, answerFile } = await pending();
    aroundAnswer(answerFile, {
      before: async () => {
        const record = {
          runId,
          pid: process.pid,
          argv: [],
          startedAt: "",
          exit: { code: null, signal: "SIGKILL" },
        };
        await project.write(`runs/${runId}/supervisor.json`, JSON.stringify(record));
      },
    });
    await expect(
      supervisor.answer(runId, promptId, { kind: "value", value: "834512" }),
    ).rejects.toThrow(`prompt ${promptId} is not pending in run ${runId}`);
    expect(existsSync(answerFile)).toBe(false);
  });

  it("counts as given when the run claims it at once", async () => {
    const { project, supervisor, answerFile } = await pending();
    // the channel claims the answer, then moves the prompt to done/
    aroundAnswer(answerFile, {
      after: async () => {
        await fs.rm(answerFile);
        await fs.rm(join(project.root, "runs", runId, "prompts", `${promptId}.json`));
      },
    });
    await expect(
      supervisor.answer(runId, promptId, { kind: "value", value: "834512" }),
    ).resolves.toBeUndefined();
  });
});
