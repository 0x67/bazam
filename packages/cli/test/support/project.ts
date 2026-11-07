import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BRAND } from "@bazam/core/brand";
import type { ExitCode } from "../../src/exit.ts";
import { main } from "../../src/main.ts";

/** A driver with no steps of its own, which runs api checks only; written as a path plugin with no imports. */
const FAKE_DRIVER = `const driver = {
  name: "fake",
  surface: "web",
  probe: async () => new Set(),
  launch: async () => ({ capabilities: new Set(), close: async () => {} }),
  steps: [],
};
export default { name: "fake", apiVersion: 1, drivers: [driver] };
`;

/** Three cases: one passes, one fails on a 500 and one is blocked because nothing listens on its port. */
const SHOP_CASES = [
  "cases:",
  "  - id: SHOP-OK-001",
  "    title: The shop answers",
  "    stage: acceptance",
  "    risk: low",
  "    links: [jira:TD-1, jira:TD-2]",
  "    targets: [t]",
  "    report: { comment: update }",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/ok", status: 200 }',
  "  - id: SHOP-FAIL-001",
  "    title: The shop reports an error",
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.API_URL}/broken", status: 200 }',
  "  - id: SHOP-DOWN-001",
  "    title: The shop cannot be reached",
  "    stage: regression",
  "    risk: low",
  "    targets: [t]",
  "    checks:",
  '      - api: { request: "GET ${env.DOWN_URL}/ok", status: 200 }',
  "",
].join("\n");

export interface Api {
  url: string;
  /** Nothing listens here, so a connection is refused. */
  downUrl: string;
  /** The paths requested so far. */
  requests: string[];
  close(): Promise<void>;
}

export async function startApi(): Promise<Api> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(req.url === "/ok" ? 200 : 500, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const downPort = (closed.address() as AddressInfo).port;
  await new Promise((done) => closed.close(done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    downUrl: `http://127.0.0.1:${downPort}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

export interface CliRun {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

export interface Fixture {
  root: string;
  /** Runs the CLI in-process from the folder above the project, which `--root` names relative to it. */
  cli(...argv: string[]): Promise<CliRun>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

const roots: string[] = [];

/** A project that passes check: the fake driver, env demo against `api`, and the three shop cases. */
export async function fixtureProject(api: Api): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cli-test-"));
  roots.push(root);
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const config = {
    envs: {
      demo: { production: false, hosts: ["127.0.0.1"], vars: { API_URL: api.url, DOWN_URL: api.downUrl } },
    },
    targets: { t: { driver: "fake" }, u: { driver: "fake" } },
    plugins: ["./fake-driver.mjs"],
  };
  // YAML reads JSON as it is
  await write(BRAND.configFile, `${JSON.stringify(config, null, 2)}\n`);
  await write("fake-driver.mjs", FAKE_DRIVER);
  await write(".gitignore", `runs/\n${BRAND.stateDir}/\n`);
  await write("cases/shop/cases.yaml", SHOP_CASES);
  return {
    root,
    cli: (...argv) => cli([...argv, "--root", basename(root)], dirname(root)),
    read: (path) => readFile(join(root, path), "utf8"),
    write,
  };
}

export async function cli(argv: readonly string[], cwd: string): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    cwd,
    signal: new AbortController().signal,
  });
  return { code, stdout, stderr };
}

export async function removeFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
