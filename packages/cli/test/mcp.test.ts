import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { caseTools } from "@bazam/mcp";
import { ExitCode } from "../src/exit.ts";
import { fixtureProject, removeFixtures, startApi, type Api } from "./support/project.ts";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(removeFixtures);

const BIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

interface Reply {
  id: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** The mcp command spawned from sources, with a JSON-RPC client on its stdin and stdout. */
function startMcp(root: string) {
  const child = spawn(process.execPath, ["--conditions=development", BIN, "mcp", "--root", root], {
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  const lines: string[] = [];
  const waiting = new Map<number, (reply: Reply) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    try {
      const reply = JSON.parse(line) as Reply;
      waiting.get(reply.id)?.(reply);
    } catch {
      // the test asserts below that every stdout line is a protocol message
    }
  });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let nextId = 0;
  return {
    child,
    exited,
    lines,
    stderr: () => stderr,
    notify: (method: string) => send({ method }),
    request(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
      const id = ++nextId;
      const reply = new Promise<Reply>((done) => waiting.set(id, done));
      send({ id, method, params });
      return reply;
    },
    async initialize(): Promise<Reply> {
      const reply = await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      });
      this.notify("notifications/initialized");
      return reply;
    },
  };
}

describe("mcp", () => {
  it("serves the twelve case tools for --root on stdio, with stdout kept for the protocol", async () => {
    const project = await fixtureProject(api);
    const mcp = startMcp(project.root);
    expect((await mcp.initialize()).result, mcp.stderr()).toHaveProperty("serverInfo");
    const tools = (await mcp.request("tools/list")).result?.["tools"] as { name: string }[];
    expect(tools).toHaveLength(12);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      caseTools.map((tool) => tool.name).sort(),
    );
    // the tools read the project the command was started on
    const search = await mcp.request("tools/call", {
      name: "cases_search",
      arguments: { text: "shop" },
    });
    const { content } = search.result as { content: { text: string }[] };
    const { cases } = JSON.parse(content[0]!.text) as { cases: { id: string }[] };
    expect(cases.map((found) => found.id).sort()).toEqual([
      "SHOP-DOWN-001",
      "SHOP-FAIL-001",
      "SHOP-OK-001",
    ]);
    mcp.child.stdin.end();
    expect(await mcp.exited, mcp.stderr()).toBe(ExitCode.Pass);
    expect(mcp.lines).toHaveLength(3);
    for (const line of mcp.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    expect(mcp.stderr()).toContain(`serving the MCP tools for ${project.root} on stdio`);
  }, 30_000);

  it("stops on the first Ctrl-C with exit 0 while stdin stays open", async () => {
    const project = await fixtureProject(api);
    const mcp = startMcp(project.root);
    await mcp.initialize();
    mcp.child.kill("SIGINT");
    expect(await mcp.exited, mcp.stderr()).toBe(ExitCode.Pass);
  }, 30_000);
});
