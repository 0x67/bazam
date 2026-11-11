import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { BRAND } from "@bazam/core/brand";
import { ExitCode } from "../src/exit.ts";
import {
  fixtureProject,
  removeFixtures,
  startApi,
  type Api,
  type Fixture,
} from "./support/project.ts";

const BIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ORDER = "ORD-48213";
// a green block with the account number, which the configured selector masks
const ACCOUNT_PAGE =
  '<!doctype html><body style="margin:0"><div id="account" style="width:300px;height:200px;background:#00ff00">ACCT-4821</div>';

const ORDER_CASE = [
  "cases:",
  "  - id: SHOP-ORDER-001",
  `    title: Order ${ORDER} ships`,
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "",
].join("\n");

const ACCOUNT_CASE = [
  "cases:",
  "  - id: SHOP-ACCOUNT-001",
  "    title: The account page shows the account number",
  "    stage: regression",
  "    risk: low",
  "    targets: [w]",
  "    steps:",
  '      - open: "${env.WEB_URL}/"',
  '      - expect: { visible: { css: "#account" } }',
  "      - screenshot: { name: account }",
  "",
].join("\n");

let api: Api;
let web: Server;
let webUrl: string;

beforeAll(async () => {
  api = await startApi();
  web = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(ACCOUNT_PAGE),
  );
  await new Promise<void>((done) => web.listen(0, "127.0.0.1", done));
  webUrl = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await api.close();
  await new Promise((done) => web.close(done));
});

afterEach(removeFixtures);

interface ConfigJson {
  envs: Record<string, { vars: Record<string, string> }>;
  targets: Record<string, unknown>;
  redaction?: unknown;
}

/** The fixture project with `redaction` in its config, a web target `w` and WEB_URL in env demo. */
async function redactingProject(redaction: unknown): Promise<Fixture> {
  const project = await fixtureProject(api);
  const config = JSON.parse(await project.read(BRAND.configFile)) as ConfigJson;
  config.envs["demo"]!.vars["WEB_URL"] = webUrl;
  config.targets["w"] = { driver: "playwright" };
  config.redaction = redaction;
  await project.write(BRAND.configFile, `${JSON.stringify(config, null, 2)}\n`);
  return project;
}

/** The RGB of one pixel of an 8-bit, non-interlaced RGB or RGBA PNG, as Playwright writes screenshots. */
function pixelAt(png: Buffer, x: number, y: number): [number, number, number] {
  const width = png.readUInt32BE(16);
  const channels = png[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT")
      idat.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const data = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const start = row * (stride + 1);
    const filter = data[start];
    const line = Buffer.from(data.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      line[i] = (line[i]! + predict(filter, left, up, upLeft)) & 0xff;
    }
    previous = line;
  }
  return [previous[x * channels]!, previous[x * channels + 1]!, previous[x * channels + 2]!];
}

function predict(filter: number | undefined, left: number, up: number, upLeft: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter !== 4) return 0;
  const p = left + up - upLeft;
  const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

/** Starts the mcp command on `root`, calls one tool and returns the text of its reply. */
async function callMcpTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const child = spawn(process.execPath, ["--conditions=development", BIN, "mcp", "--root", root], {
    stdio: "pipe",
  });
  const exited = once(child, "exit");
  const replies = new Map<number, (result: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as { id?: number; result?: unknown };
    if (reply.id !== undefined) replies.get(reply.id)?.(reply.result);
  });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (id: number, method: string, params: Record<string, unknown>) => {
    const reply = new Promise<unknown>((done) => replies.set(id, done));
    send({ id, method, params });
    return reply;
  };
  try {
    const clientInfo = { name: "test-client", version: "0.0.0" };
    await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo });
    send({ method: "notifications/initialized" });
    const result = (await request(2, "tools/call", { name, arguments: args })) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join("\n");
  } finally {
    child.stdin.end();
    await exited;
  }
}

describe("configured redaction", () => {
  it("masks a configured pattern in the run's output and evidence", async () => {
    const project = await redactingProject({ patterns: ["ORD-\\d{5}"] });
    await project.write("cases/shop/orders.yaml", ORDER_CASE);

    const { code, stdout, stderr } = await project.cli(
      "run",
      "--env",
      "demo",
      "--case",
      "SHOP-ORDER-001",
      "--run",
      "masked",
      "--json",
    );

    expect(code, stderr).toBe(ExitCode.Pass);
    expect(stdout).not.toContain(ORDER);
    expect(stdout).toContain("Order [redacted] ships");
    const result = await project.read("runs/masked/SHOP-ORDER-001/result.json");
    expect(result).not.toContain(ORDER);
    expect(JSON.parse(result)).toMatchObject({ title: "Order [redacted] ships", status: "pass" });
  });

  it("masks the elements a configured selector matches in a run's screenshots", async () => {
    const project = await redactingProject({ screenshotSelectors: ["#account"] });
    await project.write("cases/shop/account.yaml", ACCOUNT_CASE);

    const { code, stderr } = await project.cli(
      "run",
      "--env",
      "demo",
      "--case",
      "SHOP-ACCOUNT-001",
      "--run",
      "shot",
    );

    expect(code, stderr).toBe(ExitCode.Pass);
    const png = await readFile(
      join(project.root, "runs", "shot", "SHOP-ACCOUNT-001", "01-account.png"),
    );
    // Playwright paints a masked element magenta; the page paints the block green
    expect(pixelAt(png, 150, 100)).toEqual([0xff, 0x00, 0xff]);
  }, 60_000);

  it("stops the run before any case when a configured screenshot selector does not parse", async () => {
    const project = await redactingProject({ screenshotSelectors: ["#account["] });
    await project.write("cases/shop/account.yaml", ACCOUNT_CASE);

    const { code, stderr } = await project.cli(
      "run",
      "--env",
      "demo",
      "--case",
      "SHOP-ACCOUNT-001",
      "--run",
      "typo",
    );

    expect(code, stderr).toBe(ExitCode.CouldNotStart);
    expect(stderr).toContain(
      'could not launch target w: redaction.screenshotSelectors has "#account[", which Playwright cannot parse: ',
    );
  }, 60_000);

  it("masks a configured pattern in MCP replies", async () => {
    const project = await redactingProject({ patterns: ["ORD-\\d{5}"] });
    await project.write("cases/shop/orders.yaml", ORDER_CASE);

    const text = await callMcpTool(project.root, "cases_search", { text: "ships" });

    expect(text).not.toContain(ORDER);
    const { cases } = JSON.parse(text) as { cases: { id: string; title: string }[] };
    expect(cases).toEqual([
      expect.objectContaining({ id: "SHOP-ORDER-001", title: "Order [redacted] ships" }),
    ]);
  }, 30_000);

  it("reports a pattern that is not a regular expression on its line of the config", async () => {
    const project = await redactingProject({ patterns: ["ORD-\\d{5}", "(unclosed"] });
    const line =
      (await project.read(BRAND.configFile)).split("\n").indexOf('      "(unclosed"') + 1;

    const { code, stdout } = await project.cli("check");

    expect(code).toBe(ExitCode.Fail);
    expect(stdout).toContain(
      `${BRAND.configFile}:${line}: error schema: redaction.patterns[1]: not a regular expression: Invalid regular expression: /(unclosed/gu`,
    );
  });
});
