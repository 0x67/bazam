import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import type { PersonPrompt } from "@bazam/core/challenge";
import type { PostPlan } from "@bazam/core/report";
import { RunSupervisor, type RunStatus, type ToolAnswer } from "../src/runs.ts";
import {
  CLI_PATH,
  connect,
  fixtureProject,
  removeFixtures,
  textOf,
  watchRun,
  type Connection,
  type Fixture,
} from "./support/project.ts";

// a spawned run loads the CLI from its sources and the channel polls every 500 ms
const SPAWN_TIMEOUT_MS = 30_000;
const HOST = fileURLToPath(new URL("./support/host.ts", import.meta.url));

const connections: Connection[] = [];
const pids: number[] = [];

afterEach(async () => {
  killRuns();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await removeFixtures();
});

function killRuns(): void {
  for (const pid of pids.splice(0)) {
    try {
      // the run leads its own process group
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        // a run that does not lead its group fails a test below, but must not outlive the suite
        process.kill(pid, "SIGKILL");
      } catch {
        // already ended
      }
    }
  }
}

async function open(project: Fixture): Promise<Connection> {
  const connection = await connect(project.root, { supervisor: new RunSupervisor(project.root, CLI_PATH) });
  connections.push(connection);
  return connection;
}

async function start(mcp: Connection, project: Fixture): Promise<string> {
  const { runId } = await mcp.json<{ runId: string }>("run_start", { env: "demo", seed: 42 });
  const record = JSON.parse(await project.read(`runs/${runId}/supervisor.json`)) as { pid: number };
  pids.push(record.pid);
  watchRun(project.root, runId);
  return runId;
}

async function waitFor<T>(what: string, poll: () => Promise<T | undefined>, ms = SPAWN_TIMEOUT_MS - 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await poll();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function pendingPrompt(mcp: Connection, runId: string): Promise<PersonPrompt> {
  return waitFor("a prompt", async () => {
    const { prompts } = await mcp.json<{ prompts: PersonPrompt[] }>("prompt_list", { runId });
    return prompts[0];
  });
}

async function finished(mcp: Connection, runId: string): Promise<RunStatus> {
  return waitFor("the run to finish", async () => {
    const status = await mcp.json<RunStatus>("run_status", { runId });
    return status.state === "finished" ? status : undefined;
  });
}

const PASS: ToolAnswer = { kind: "verdict", verdict: "pass", note: "tidy" };

describe("runs over MCP", () => {
  it(
    "run_start returns before the run ends",
    async () => {
      const project = await fixtureProject();
      const mcp = await open(project);
      const runId = await start(mcp, project);
      const status = await mcp.json<RunStatus>("run_status", { runId });
      expect(["starting", "running"]).toContain(status.state);
      expect(status.pid).toBe(pids[0]);

      // the guided step waits for a person, so the run is still going once the prompt is up
      const prompt = await pendingPrompt(mcp, runId);
      expect(prompt).toMatchObject({ id: "DESK-LOOK-001-1-guided", runId, caseId: "DESK-LOOK-001", ask: "verdict" });
      expect(await mcp.json<RunStatus>("run_status", { runId })).toMatchObject({
        runId,
        state: "running",
        total: 1,
        pendingPrompts: 1,
        results: [],
      });
      const record = JSON.parse(await project.read(`runs/${runId}/supervisor.json`)) as { argv: string[] };
      expect(record.argv).toEqual(
        expect.arrayContaining([CLI_PATH, "run", "--json", `--run=${runId}`, "--channel=answers-file", "--env=demo"]),
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "prompt_answer lets the run finish",
    async () => {
      const project = await fixtureProject();
      const mcp = await open(project);
      const runId = await start(mcp, project);
      const prompt = await pendingPrompt(mcp, runId);

      // a verdict prompt takes no done, and a refused answer writes no file
      const refused = await mcp.call("prompt_answer", { runId, promptId: prompt.id, answer: { kind: "done" } });
      expect(textOf(refused)).toBe(`prompt ${prompt.id} asks for verdict: answer with a verdict`);
      expect(existsSync(join(project.root, "runs", runId, "answers", `${prompt.id}.json`))).toBe(false);

      expect(await mcp.json("prompt_answer", { runId, promptId: prompt.id, answer: PASS })).toEqual({ ok: true });
      const status = await finished(mcp, runId);
      expect(status).toMatchObject({ state: "finished", total: 1, pendingPrompts: 0 });
      expect(status.results).toEqual([{ caseId: "DESK-LOOK-001", status: "pass" }]);
      expect(await mcp.json("prompt_list", { runId })).toEqual({ prompts: [] });
      const exited = await waitFor("the exit code", async () => {
        const { exit } = await mcp.json<RunStatus>("run_status", { runId });
        return exit;
      });
      expect(exited).toEqual({ code: 0, signal: null });
      // the run's --json summary goes to its log, since the server's stdout carries the protocol
      expect(JSON.parse(await project.read(`runs/${runId}/stdout.log`))).toMatchObject({
        runId,
        counts: { pass: 1, total: 1 },
      });
      const answered = await mcp.call("prompt_answer", { runId, promptId: prompt.id, answer: PASS });
      expect(textOf(answered)).toBe(`prompt ${prompt.id} is not pending in run ${runId}`);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "state survives a server restart",
    async () => {
      const project = await fixtureProject();
      const first = await open(project);
      const runId = await start(first, project);
      const prompt = await pendingPrompt(first, runId);
      await first.close();

      const second = await open(project);
      expect(await second.json("prompt_list", { runId })).toEqual({ prompts: [prompt] });
      expect(await second.json<RunStatus>("run_status", { runId })).toMatchObject({
        state: "running",
        pid: pids[0],
        pendingPrompts: 1,
      });
      await second.json("prompt_answer", { runId, promptId: prompt.id, answer: PASS });
      expect((await finished(second, runId)).results).toEqual([{ caseId: "DESK-LOOK-001", status: "pass" }]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a run goes on after Ctrl-C ends the server that started it",
    async () => {
      const project = await fixtureProject();
      // the server leads its own process group, as a command started in a terminal does, so the group is what
      // Ctrl-C signals
      const host = spawn(process.execPath, [...process.execArgv, HOST, project.root, CLI_PATH], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      pids.push(host.pid!);
      let stdout = "";
      let stderr = "";
      host.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
      host.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
      const runId = await waitFor("the run id", async () => {
        if (host.exitCode !== null) throw new Error(`the server exited: ${stderr}`);
        return stdout.endsWith("\n") ? stdout.trim() : undefined;
      });
      const record = JSON.parse(await project.read(`runs/${runId}/supervisor.json`)) as { pid: number };
      // not watched: the supervisor that would record the exit ends with the host
      pids.push(record.pid);
      const supervisor = new RunSupervisor(project.root, CLI_PATH);
      // the run handles Ctrl-C once its cases run, and the prompt shows they do
      const prompt = await waitFor("a prompt", async () => (await supervisor.prompts(runId))[0]);

      const exited = once(host, "exit");
      process.kill(-host.pid!, "SIGINT");
      // the run holds no reference on the server's event loop, so the server exits once it stops serving
      const [code, signal] = await Promise.race([
        exited,
        sleep(10_000).then(() => Promise.reject(new Error("the server did not exit after Ctrl-C"))),
      ]);
      expect({ code, signal }).toEqual({ code: 0, signal: null });

      // a run that got the Ctrl-C too would end its case cancelled instead
      await supervisor.answer(runId, prompt.id, PASS);
      const status = await waitFor("the run to finish", async () => {
        const current = await supervisor.status(runId);
        return current.state === "finished" ? current : undefined;
      });
      expect(status.results).toEqual([{ caseId: "DESK-LOOK-001", status: "pass" }]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a run killed while its prompt waits shows as stopped and takes no answer",
    async () => {
      const project = await fixtureProject();
      const mcp = await open(project);
      const runId = await start(mcp, project);
      const prompt = await pendingPrompt(mcp, runId);
      // the CLI handles only SIGINT, so SIGTERM ends it before its channel moves the prompt to done/
      process.kill(pids[0]!, "SIGTERM");
      const status = await waitFor("the run to stop", async () => {
        const current = await mcp.json<RunStatus>("run_status", { runId });
        return current.state === "stopped" ? current : undefined;
      });
      expect(status.exit).toEqual({ code: null, signal: "SIGTERM" });
      expect(existsSync(join(project.root, "runs", runId, "prompts", `${prompt.id}.json`))).toBe(true);

      expect(await mcp.json("prompt_list", { runId })).toEqual({ prompts: [] });
      const answered = await mcp.call("prompt_answer", { runId, promptId: prompt.id, answer: PASS });
      expect(textOf(answered)).toBe(`run ${runId} has stopped, so prompt ${prompt.id} can no longer be answered`);
      expect(existsSync(join(project.root, "runs", runId, "answers", `${prompt.id}.json`))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a finished run reports, acknowledges the posted comment and promotes the case",
    async () => {
      const project = await fixtureProject();
      const mcp = await open(project);
      const runId = await start(mcp, project);
      const prompt = await pendingPrompt(mcp, runId);
      await mcp.json("prompt_answer", { runId, promptId: prompt.id, answer: PASS });
      await finished(mcp, runId);

      const plan = await mcp.json<PostPlan>("report_plan", { runId });
      const marker = `${BRAND.markerPrefix}:DESK-LOOK-001:${runId}`;
      expect(plan.items).toEqual([
        expect.objectContaining({
          marker,
          caseId: "DESK-LOOK-001",
          status: "pass",
          ticket: { tracker: "jira", key: "TD-1" },
        }),
      ]);
      const url = "https://jira.example.test/browse/TD-1?focusedCommentId=10001";
      expect(await mcp.json("report_ack", { marker, url })).toEqual({
        marker,
        ticket: "jira:TD-1",
        caseId: "DESK-LOOK-001",
      });
      expect(await project.read(`${BRAND.stateDir}/receipts.json`)).toContain(url);
      const again = await mcp.json<PostPlan>("report_plan", { runId });
      // the case asks to update its comment, so the next plan edits the one acknowledged
      expect(again.items[0]?.edit).toEqual({ url });

      expect(await mcp.json("case_promote", { id: "DESK-LOOK-001", env: "demo" })).toEqual({
        caseId: "DESK-LOOK-001",
        ok: true,
      });
      expect(await project.read("cases/desk/cases.yaml")).toContain("stage: regression");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a run that cannot start shows as stopped with the error output",
    async () => {
      const project = await fixtureProject();
      const supervisor = new RunSupervisor(project.root, CLI_PATH);
      // the tool refuses an unknown env before it spawns, so call the supervisor itself
      const { runId } = await supervisor.start({}, "nowhere");
      watchRun(project.root, runId);
      const status = await waitFor("the run to stop", async () => {
        const current = await supervisor.status(runId);
        return current.state === "stopped" ? current : undefined;
      });
      expect(status.exit).toEqual({ code: 2, signal: null });
      expect(status.stderr).toContain('unknown env "nowhere"');
      expect(await readdir(join(project.root, "runs", runId))).not.toContain("status.json");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("fixture teardown", () => {
  it(
    "waits for the supervisor to record a killed run's exit before it removes the run",
    async () => {
      const roots = await Promise.all(
        [1, 2, 3].map(async () => {
          const project = await fixtureProject();
          const { runId } = await new RunSupervisor(project.root, CLI_PATH).start({}, "demo", 42);
          watchRun(project.root, runId);
          const record = JSON.parse(await project.read(`runs/${runId}/supervisor.json`)) as { pid: number };
          pids.push(record.pid);
          // a full folder keeps rm busy long enough for the exit write to land in it
          const bulk = join(project.root, "runs", runId, "bulk");
          await mkdir(bulk);
          await Promise.all(Array.from({ length: 2000 }, (_, n) => writeFile(join(bulk, `${n}.txt`), "x")));
          return project.root;
        }),
      );
      killRuns();
      await removeFixtures();
      expect(roots.filter((root) => existsSync(root))).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("RunSupervisor answers", () => {
  const runId = "20261107-120000-abcd";
  const prompt = (id: string, ask: PersonPrompt["ask"]): PersonPrompt => ({
    id,
    runId,
    caseId: "DESK-LOOK-001",
    ask,
    title: "Look",
    steps: [],
    timeoutMs: 1000,
  });

  it("writes an answer the prompt takes, as given, and refuses one it does not", async () => {
    const project = await fixtureProject();
    for (const ask of ["action", "value", "verdict"] as const) {
      await project.write(`runs/${runId}/prompts/P-${ask}.json`, JSON.stringify(prompt(`P-${ask}`, ask)));
    }
    await project.write(`runs/${runId}/prompts/P-temp.json.0000.tmp`, "{");
    const supervisor = new RunSupervisor(project.root, CLI_PATH);
    expect((await supervisor.prompts(runId)).map((p) => p.id)).toEqual(["P-action", "P-value", "P-verdict"]);

    await expect(supervisor.answer(runId, "P-action", { kind: "value", value: "2468" })).rejects.toThrow(
      "prompt P-action asks for action: answer done or a verdict, never a value",
    );
    await expect(supervisor.answer(runId, "P-value", { kind: "verdict", verdict: "pass", note: "" })).rejects.toThrow(
      "answer with the value, or a fail or blocked verdict",
    );
    await expect(supervisor.answer(runId, "P-gone", { kind: "done" })).rejects.toThrow(
      `prompt P-gone is not pending in run ${runId}`,
    );
    await expect(supervisor.answer(runId, "../P-action", { kind: "done" })).rejects.toThrow("not a plain file name");
    await expect(supervisor.prompts("..")).rejects.toThrow("not a plain file name");
    expect(existsSync(join(project.root, "runs", runId, "answers"))).toBe(false);

    await supervisor.answer(runId, "P-action", { kind: "done" });
    await supervisor.answer(runId, "P-value", { kind: "value", value: "2468" });
    await supervisor.answer(runId, "P-verdict", { kind: "verdict", verdict: "blocked", note: "no desk" });
    const answers = join(project.root, "runs", runId, "answers");
    expect((await readdir(answers)).sort()).toEqual(["P-action.json", "P-value.json", "P-verdict.json"]);
    expect(JSON.parse(await project.read(`runs/${runId}/answers/P-value.json`))).toEqual({
      kind: "value",
      value: "2468",
    });
  });

  it("a run whose process ended unseen lists no prompts and takes no answer", async () => {
    const project = await fixtureProject();
    // a pid that no longer runs and no exit, as when the server that started the run was killed before the run
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(gone, "exit");
    const record = { runId, pid: gone.pid, argv: [], startedAt: "2026-11-07T12:00:00.000Z" };
    await project.write(`runs/${runId}/supervisor.json`, JSON.stringify(record));
    await project.write(`runs/${runId}/prompts/P-value.json`, JSON.stringify(prompt("P-value", "value")));
    const supervisor = new RunSupervisor(project.root, CLI_PATH);

    expect(await supervisor.status(runId)).toMatchObject({ state: "stopped", pid: gone.pid });
    expect(await supervisor.prompts(runId)).toEqual([]);
    await expect(supervisor.answer(runId, "P-value", { kind: "value", value: "2468" })).rejects.toThrow(
      `run ${runId} has stopped, so prompt P-value can no longer be answered`,
    );
    expect(existsSync(join(project.root, "runs", runId, "answers"))).toBe(false);
  });
});
