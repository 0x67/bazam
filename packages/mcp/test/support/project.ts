import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BRAND } from "@bazam/core/brand";
import { defaultRedactionRules, Redactor } from "@bazam/core/redact";
import { createMcpServer } from "../../src/server.ts";
import { RunSupervisor } from "../../src/runs.ts";

/** The CLI's main script, run from its sources; a path, not an import. */
export const CLI_PATH = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));

/** A driver with no steps of its own; written as a path plugin with no imports. */
const FAKE_DRIVER = `const driver = {
  name: "fake",
  surface: "web",
  probe: async () => new Set(),
  launch: async () => ({ capabilities: new Set(), close: async () => {} }),
  steps: [],
};
export default { name: "fake", apiVersion: 1, drivers: [driver] };
`;

/** A guided case a person answers, and a case with an api check, both passing check. */
export const DESK_CASES = [
  "cases:",
  "  - id: DESK-LOOK-001",
  "    title: A person looks at the desk",
  "    stage: acceptance",
  "    risk: low",
  "    links: [jira:TD-1]",
  "    targets: [t]",
  "    tags: [visual]",
  "    report: { comment: update }",
  "    steps:",
  "      - guided:",
  "          title: Look at the desk",
  "          steps: [Open the desk page]",
  "          expected: The desk is tidy",
  "  - id: DESK-OLD-001",
  "    title: The old desk lamp",
  "    stage: retired",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/lamp", status: 200 }',
  "",
].join("\n");

export interface Fixture {
  root: string;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

const roots: string[] = [];
const watchedRuns: string[] = [];

/** A project with the fake driver, env demo and the desk cases. */
export async function fixtureProject(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "mcp-test-"));
  roots.push(root);
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const config = {
    envs: { demo: { production: false, hosts: ["127.0.0.1"], vars: { API_URL: "http://127.0.0.1:9" } } },
    targets: { t: { driver: "fake" } },
    plugins: ["./fake-driver.mjs"],
  };
  // YAML reads JSON as it is
  await write(BRAND.configFile, `${JSON.stringify(config, null, 2)}\n`);
  await write("fake-driver.mjs", FAKE_DRIVER);
  await write(".gitignore", `runs/\n${BRAND.stateDir}/\n`);
  await write("cases/desk/cases.yaml", DESK_CASES);
  return { root, read: (path) => readFile(join(root, path), "utf8"), write };
}

/**
 * Marks a run whose supervisor lives in this process, which writes the run's exit into its supervisor.json once the
 * process ends. Stop the run before removeFixtures, which waits for that record.
 */
export function watchRun(root: string, runId: string): void {
  watchedRuns.push(join(root, "runs", runId));
}

export async function removeFixtures(): Promise<void> {
  // removing a run folder while the exit write lands in it fails with ENOTEMPTY
  await Promise.all(watchedRuns.splice(0).map(exitRecorded));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

const EXIT_RECORD_TIMEOUT_MS = 5000;

async function exitRecorded(runDir: string): Promise<void> {
  const deadline = Date.now() + EXIT_RECORD_TIMEOUT_MS;
  for (;;) {
    const record = JSON.parse(await readFile(join(runDir, "supervisor.json"), "utf8")) as { exit?: unknown };
    if (record.exit !== undefined) return;
    if (Date.now() > deadline) throw new Error(`no exit was recorded for ${runDir}; is the run still going?`);
    await sleep(20);
  }
}

export interface Connection {
  server: McpServer;
  client: Client;
  redactor: Redactor;
  /** The raw tool result. */
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** The JSON document of a successful call; throws with the error text otherwise. */
  json<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** A server on `root` with a client linked to it in memory. */
export async function connect(
  root: string,
  options: { redactor?: Redactor; supervisor?: RunSupervisor } = {},
): Promise<Connection> {
  const redactor = options.redactor ?? new Redactor(defaultRedactionRules());
  const supervisor = options.supervisor ?? new RunSupervisor(root, CLI_PATH);
  const server = createMcpServer({ projectRoot: root, supervisor, redactor });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return {
    server,
    client,
    redactor,
    call,
    async json<T>(name: string, args: Record<string, unknown> = {}) {
      const result = await call(name, args);
      const text = textOf(result);
      if (result.isError === true) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text) as T;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The first text part of a tool result. */
export function textOf(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("the result has no text part");
  return first.text;
}
