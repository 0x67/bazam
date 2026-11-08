import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { METHODS } from "../src/plugin/protocol.ts";
import { JsonRpcPeer, RpcError } from "../src/plugin/rpc.ts";

const SECRET = "sk-example-4421";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 200) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Two peers wired to each other, with one log for both. */
function pair(): { a: JsonRpcPeer; b: JsonRpcPeer; logged: string[] } {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const logged: string[] = [];
  const a = new JsonRpcPeer(bToA, aToB, { log: (line) => logged.push(`a: ${line}`) });
  const b = new JsonRpcPeer(aToB, bToA, { log: (line) => logged.push(`b: ${line}`) });
  return { a, b, logged };
}

/** One peer driven by hand-written lines, with every message it sends kept in order. */
function wired(options: { maxLineBytes?: number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logged: string[] = [];
  const peer = new JsonRpcPeer(input, output, { ...options, log: (line) => logged.push(line) });
  const sent: unknown[] = [];
  createInterface({ input: output }).on("line", (line) => sent.push(JSON.parse(line) as unknown));
  let read = 0;
  return {
    peer,
    logged,
    input,
    output,
    sent,
    write: (text: string): void => {
      input.write(text);
    },
    next: async (): Promise<unknown> => {
      await waitFor(() => sent.length > read);
      return sent[read++];
    },
  };
}

function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

/** A handler that waits until its signal aborts, then rejects with the reason. */
function hang(aborted: { signal?: AbortSignal }): (params: unknown, signal: AbortSignal) => Promise<unknown> {
  return (_params, signal) =>
    new Promise((_resolve, reject) => {
      aborted.signal = signal;
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    });
}

describe("JsonRpcPeer", () => {
  it("sends requests both ways and matches each answer to its request", async () => {
    const { a, b } = pair();
    const gate = Promise.withResolvers<void>();
    a.handle("slow", async () => {
      await gate.promise;
      return "slow done";
    });
    a.handle("add", async (params) => {
      const { x, y } = params as { x: number; y: number };
      return x + y;
    });
    b.handle("greet", async (params) => `hello ${(params as { name: string }).name}`);
    b.handle("nothing", async () => undefined);

    const slow = b.request<string>("slow", {}, {});
    const sum = b.request<number>("add", { x: 2, y: 3 }, {});
    expect(await sum).toBe(5);
    expect(await a.request("greet", { name: "ana" }, {})).toBe("hello ana");
    expect(await a.request("nothing", {}, {})).toBeNull();
    gate.resolve();
    expect(await slow).toBe("slow done");
  });

  it("answers a handler's RpcError with its code and data, any other failure with -32603, and an unknown method with -32601", async () => {
    const { a, b, logged } = pair();
    a.handle("blocked", async () => {
      throw new RpcError(-32001, "host example.test is not allowed", { host: "example.test" });
    });
    a.handle("broken", async () => {
      throw new Error(`token ${SECRET} was refused`);
    });

    await expect(b.request("blocked", {}, {})).rejects.toMatchObject({
      name: "RpcError",
      code: -32001,
      message: "host example.test is not allowed",
      data: { host: "example.test" },
    });
    const broken = b.request("broken", { password: SECRET }, {});
    await expect(broken).rejects.toBeInstanceOf(RpcError);
    await expect(broken).rejects.toMatchObject({ code: -32603, message: `token ${SECRET} was refused` });
    await expect(b.request("missing", {}, {})).rejects.toMatchObject({ code: -32601 });

    expect(logged).toContain('a: answered "broken" request 2 with error -32603');
    expect(logged).toContain('a: answered "missing" request 3 with error -32601');
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("delivers a notification to its handler and answers nothing", async () => {
    const { peer, write, next } = wired();
    const lines: string[] = [];
    peer.handle("host.log", async (params) => {
      lines.push((params as { line: string }).line);
    });
    peer.handle("ping", async () => "pong");

    write(`${JSON.stringify({ jsonrpc: "2.0", method: "host.log", params: { line: "launched" } })}\n`);
    write(`${JSON.stringify({ jsonrpc: "2.0", method: "unknown.notification", params: {} })}\n`);
    write(`${JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "ping" })}\n`);

    expect(await next()).toEqual({ jsonrpc: "2.0", id: "p1", result: "pong" });
    expect(lines).toEqual(["launched"]);
  });

  it("ignores an answer to a request it never sent and logs only its id", async () => {
    const { peer, write, next, logged } = wired();
    peer.handle("ping", async () => "pong");

    write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, result: SECRET })}\n`);
    write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);

    expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });
    expect(logged).toEqual(["ignored an answer to unknown request 99"]);
  });

  it("sends $/cancelRequest and rejects with the signal's reason when the caller aborts", async () => {
    const { a, b } = pair();
    const handler: { signal?: AbortSignal } = {};
    a.handle("hang", hang(handler));
    const controller = new AbortController();
    const reason = new Error("case cancelled");

    const call = b.request("hang", {}, { signal: controller.signal });
    await waitFor(() => handler.signal !== undefined);
    controller.abort(reason);

    await expect(call).rejects.toBe(reason);
    await waitFor(() => handler.signal?.aborted === true);
  });

  it("answers a cancelled handler that then fails with -32002", async () => {
    const { peer, write, next } = wired();
    peer.handle("hang", hang({}));

    write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "hang", params: {} })}\n`);
    write(`${JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } })}\n`);

    expect(await next()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32002 } });
  });

  it("rejects at once and sends nothing when the signal has already aborted", async () => {
    const { peer, next } = wired();
    const reason = new Error("already stopped");

    await expect(peer.request("ping", {}, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    peer.notify("marker", {});

    expect(await next()).toEqual({ jsonrpc: "2.0", method: "marker", params: {} });
  });

  it("rejects with a TimeoutError and cancels the call on the other side when no answer comes in time", async () => {
    const { a, b } = pair();
    const handler: { signal?: AbortSignal } = {};
    a.handle("hang", hang(handler));

    const call = b.request("hang", {}, { timeoutMs: 20 });
    await expect(call).rejects.toBeInstanceOf(DOMException);
    await expect(call).rejects.toMatchObject({ name: "TimeoutError" });
    await waitFor(() => handler.signal?.aborted === true);
  });

  it("refuses a batch with -32600 and runs none of its requests", async () => {
    const { peer, write, next } = wired();
    let ran = false;
    peer.handle("ping", async () => {
      ran = true;
      return "pong";
    });

    write(`${JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])}\n`);

    expect(await next()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(ran).toBe(false);
  });

  it("drops lines that hold no message without answering them and logs only their count on close", async () => {
    const { peer, write, next, logged } = wired();
    peer.handle("ping", async () => "pong");

    write(`starting with token ${SECRET}\n`);
    write("42\n");
    write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });

    peer.close(new Error("plugin exited"));
    expect(logged).toEqual(["dropped 2 input lines that held no JSON-RPC message"]);
  });

  it("reads a message split across chunks and closes on a line over the limit", async () => {
    const { peer, write, next } = wired({ maxLineBytes: 64 });
    peer.handle("ping", async () => "pong");
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

    write(request.slice(0, 10));
    write(`${request.slice(10)}\n`);
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });

    const pending = peer.request("ping", {}, {});
    write("x".repeat(40));
    write("x".repeat(40));
    await expect(pending).rejects.toThrow("received a line longer than 64 bytes");
    await expect(peer.request("ping", {}, {})).rejects.toThrow("received a line longer than 64 bytes");
  });

  it("keeps pending requests open when the input ends and rejects them on close", async () => {
    const { peer, input, output, sent, next } = wired();
    const handler: { signal?: AbortSignal } = {};
    peer.handle("hang", hang(handler));
    const reason = new Error("plugin exited with code 1");

    const call = peer.request("ping", {}, {});
    const isSettled = settled(call);
    expect(await next()).toMatchObject({ id: 1, method: "ping" });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "hang" })}\n`);
    await waitFor(() => handler.signal !== undefined);
    input.end();
    await tick();
    expect(isSettled()).toBe(false);

    peer.close(reason);
    await expect(call).rejects.toBe(reason);
    await expect(peer.request("ping", {}, {})).rejects.toBe(reason);
    expect(handler.signal?.aborted).toBe(true);
    peer.notify("host.log", { line: "after close" });
    await tick();
    expect(sent).toHaveLength(1);
    expect(output.writableEnded).toBe(false);
  });

  it("survives an error on either stream and logs it by name only", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logged: string[] = [];
    const peer = new JsonRpcPeer(input, output, { log: (line) => logged.push(line) });

    output.destroy(new Error(`EPIPE ${SECRET}`));
    input.destroy(new Error(`read failed ${SECRET}`));
    peer.notify("host.log", { line: "to a closed pipe" });
    await tick();

    expect(logged).toEqual(expect.arrayContaining(["output stream emitted error", "input stream emitted error"]));
    expect(logged.join("\n")).not.toContain(SECRET);
    peer.close(new Error("done"));
  });
});

describe("METHODS", () => {
  const env = {
    name: "uat",
    production: false,
    vars: {},
    hosts: ["uat.example.test"],
    challenges: {},
    locale: "en",
  };
  const launchOptions = {
    env,
    target: "web",
    settings: { browser: "chromium" },
    runDir: "/runs/r1",
    redaction: { screenshotSelectors: [] },
  };

  it("refuses a zip attachment with the reason core gives", () => {
    const result = METHODS["host.evidence.attach"].params.safeParse({
      contextId: "c1",
      label: "trace",
      ext: "zip",
      dataBase64: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("a process plugin cannot attach zip files, which core cannot scrub");
  });

  it("takes a check record whose undefined values the JSON line dropped", () => {
    const check = { name: "banner shows", kind: "ui", expected: "visible", observed: undefined, ok: false };
    const wire: unknown = JSON.parse(JSON.stringify({ contextId: "c1", check }));
    expect(METHODS["host.evidence.record"].params.safeParse(wire).success).toBe(true);
  });

  it("keeps contribution types it does not know, so the loader can name them", () => {
    const step = z.toJSONSchema(z.object({ url: z.string() }), { io: "input" });
    const result = METHODS.initialize.result.parse({
      name: "example-plugin",
      apiVersion: 1,
      contributions: {
        drivers: [{ name: "fake", surface: "web", steps: [{ kind: "open", schema: step }] }],
        checkRules: [],
      },
    });
    expect(Object.keys(result.contributions)).toEqual(["drivers", "checkRules"]);
    expect(result.contributions.drivers?.[0]?.steps[0]?.schema).toEqual(step);
  });

  it("gives a probe or launch a context id, so the driver can call the host", () => {
    expect(METHODS["driver.launch"].params.safeParse({ driver: "fake", options: launchOptions }).success).toBe(false);
    expect(
      METHODS["driver.probe"].params.safeParse({ driver: "fake", options: { ...launchOptions, contextId: "c1" } })
        .success,
    ).toBe(true);
  });
});
