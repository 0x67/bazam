// A plugin that speaks the protocol by hand and misbehaves as its first argument says.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "plain";
const secret = process.env["RAW_SECRET"] ?? "none";
const pidFile = process.env["RAW_PID_FILE"];
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

if (mode === "early-exit") {
  process.stderr.write(`starting with ${secret}\nno config found\n`);
  process.exit(3);
}
if (mode === "mute") process.stderr.write(`waiting with ${secret}\n`);

const driver = { drivers: [{ name: "raw", surface: "web", steps: [{ kind: "peek", schema: { type: "object" } }] }] };
// a shape that protocol version 1 does not have
const misshapen = { secretProviders: ["raw-secrets"] };
const CONTRIBUTIONS: Record<string, object> = {
  refused: { authStrategies: [] },
  "bad-schema": { drivers: [{ name: "raw", surface: "web", steps: [{ kind: "odd", schema: { type: "weird" } }] }] },
  stubborn: { secretProviders: [{ name: "stubborn-secrets" }] },
  shape: misshapen,
  "version-shape": misshapen,
  "launch-http": driver,
  "step-secret": driver,
  "step-string-error": driver,
  "step-codeless-error": driver,
  "step-cookies": driver,
};
// driver.step answers in these modes, with an error that is not a JSON-RPC error object
const BROKEN_ERRORS: Record<string, unknown> = {
  "step-string-error": "device not reachable",
  "step-codeless-error": { message: "device not reachable" },
};
const contributions = CONTRIBUTIONS[mode] ?? { secretProviders: [{ name: "raw-secrets" }] };

interface Message {
  id?: number;
  method?: string;
  params?: { id?: number; options?: { contextId: string }; context?: { contextId: string }; step?: { url?: string } };
  result?: unknown;
  error?: unknown;
}

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

// host calls that wait for their answers, by request id
const asked = new Map<number, (answer: Message) => void>();

/** Sends one host call and hands its answer to `then`. */
function ask(method: string, params: object, then: (answer: Message) => void): void {
  const hostId = asked.size + 1;
  asked.set(hostId, then);
  send({ id: hostId, method, params });
}

/** Sends one host call and answers request `id` with the error the host gave back. */
function relay(id: number | undefined, method: string, params: object): void {
  ask(method, params, (answer) => send({ id, error: answer.error }));
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Message;
  const { id } = message;
  if (message.method === undefined && id !== undefined) {
    asked.get(id)?.(message);
    return;
  }
  switch (message.method) {
    case "initialize":
      if (mode === "mute") return;
      send({
        id,
        result: {
          protocolVersion: mode.startsWith("version") ? 2 : 1,
          name: "raw",
          apiVersion: mode === "api" ? 2 : 1,
          contributions,
        },
      });
      return;
    case "secrets.load":
      process.stderr.write(`loading with ${secret}\n`);
      send({ method: "host.log", params: { line: `log ${secret}` } });
      if (mode === "stall") return;
      if (mode === "orphan") {
        // the grandchild keeps stdout and stderr open after this process exits
        const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        writeFileSync(process.env["RAW_GRANDCHILD_PID_FILE"] ?? "", String(grandchild.pid));
        process.exit(6);
      }
      send({ id, result: mode === "bad-result" ? 42 : "raw-value" });
      return;
    case "driver.probe":
      send({ id, result: [] });
      return;
    case "driver.launch":
      if (mode === "launch-http") {
        const request = { method: "GET", url: "http://127.0.0.1/", headers: {} };
        relay(id, "host.http", { contextId: message.params?.options?.contextId, request });
        return;
      }
      send({ id, result: { session: "raw-session", capabilities: [] } });
      return;
    case "driver.step":
      if (mode in BROKEN_ERRORS) {
        send({ id, error: BROKEN_ERRORS[mode] });
        return;
      }
      if (mode === "step-cookies") {
        // the host.http result as it came over the wire, as a plugin in another language reads it
        const request = { method: "GET", url: message.params?.step?.url, headers: {} };
        ask("host.http", { contextId: message.params?.context?.contextId, request }, (answer) => {
          writeFileSync(process.env["RAW_RESULT_FILE"] ?? "", JSON.stringify(answer.result ?? answer.error));
          send({ id, result: null });
        });
        return;
      }
      relay(id, "host.secret", { contextId: message.params?.context?.contextId, key: "RAW_SECRET" });
      return;
    case "driver.close":
      send({ id, result: null });
      return;
    case "$/cancelRequest":
      process.stderr.write(`cancelled request ${message.params?.id}\n`);
      return;
    case "shutdown":
      send({ id, result: null });
      return;
  }
});

if (mode === "stubborn") {
  // stays up after stdin ends and through SIGTERM, so only SIGKILL ends it
  process.on("SIGTERM", () => process.stderr.write("ignoring SIGTERM\n"));
  setInterval(() => {}, 60_000);
}
