import type { Readable, Writable } from "node:stream";

const MAX_LINE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;
const CANCEL_METHOD = "$/cancelRequest";
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const CANCELLED = -32002;

type Id = number | string;
type Handler = (params: unknown, signal: AbortSignal) => Promise<unknown>;

interface Pending {
  resolve(result: unknown): void;
  reject(reason: unknown): void;
}

/** A JSON-RPC error answer, or one a handler throws to answer with its own code. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * One side of a JSON-RPC 2.0 connection over newline-delimited JSON, which sends and answers requests both ways.
 * Its log gets method names, ids and error codes only, never params, results or messages, since they may hold secrets.
 */
export class JsonRpcPeer {
  readonly #output: Writable;
  readonly #maxLineBytes: number;
  readonly #log: (line: string) => void;
  readonly #handlers = new Map<string, Handler>();
  readonly #pending = new Map<number, Pending>();
  // incoming requests whose handlers still run, so a cancel or close can abort them
  readonly #running = new Map<Id, AbortController>();
  readonly #lifetime = new AbortController();
  #nextId = 1;
  #partial: Buffer[] = [];
  #partialBytes = 0;
  #dropped = 0;
  #closed: Error | undefined;

  constructor(input: Readable, output: Writable, options: { maxLineBytes?: number; log?(line: string): void }) {
    this.#output = output;
    this.#maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    this.#log = (line) => options.log?.(line);
    input.on("data", (chunk: Buffer | string) => this.#receive(chunk));
    // a dead pipe must not crash the process; the owner learns of the exit and calls close
    input.on("error", () => this.#log("input stream emitted error"));
    output.on("error", () => this.#log("output stream emitted error"));
  }

  handle(method: string, handler: Handler): void {
    this.#handlers.set(method, handler);
  }

  /**
   * Rejects with `signal.reason` when the signal aborts, and with a `DOMException` named `TimeoutError` when
   * `timeoutMs` passes; either way the other side gets `$/cancelRequest`.
   */
  request<T>(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    const { signal, timeoutMs } = options;
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#pending.delete(id);
    };
    const abandon = (reason: unknown): void => {
      finish();
      this.notify(CANCEL_METHOD, { id });
      reject(reason);
    };
    const onAbort = (): void => abandon(signal?.reason);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => abandon(new DOMException(`${method} got no answer within ${timeoutMs} ms`, "TimeoutError")),
            timeoutMs,
          );
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#pending.set(id, {
      resolve: (result) => {
        finish();
        resolve(result as T);
      },
      reject: (reason) => {
        finish();
        reject(reason);
      },
    });
    this.#write(line);
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Rejects every pending request with `reason`, and each later one at once; aborts the signals of running
   * handlers and stops reading. It leaves `output` open, so its owner decides when to end it.
   */
  close(reason: Error): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    this.#partial = [];
    this.#partialBytes = 0;
    for (const pending of this.#pending.values()) pending.reject(reason);
    for (const controller of this.#running.values()) controller.abort(reason);
    this.#running.clear();
    this.#lifetime.abort(reason);
    if (this.#dropped > 0) {
      this.#log(
        `dropped ${this.#dropped} input ${this.#dropped === 1 ? "line" : "lines"} that held no JSON-RPC message`,
      );
    }
  }

  #receive(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    for (
      let end = bytes.indexOf(NEWLINE);
      end !== -1 && this.#closed === undefined;
      end = bytes.indexOf(NEWLINE, start)
    ) {
      if (!this.#keep(bytes.subarray(start, end))) return;
      const line = Buffer.concat(this.#partial, this.#partialBytes).toString("utf8");
      this.#partial = [];
      this.#partialBytes = 0;
      start = end + 1;
      this.#message(line);
    }
    if (this.#closed === undefined) this.#keep(bytes.subarray(start));
  }

  /** Adds `bytes` to the line being read; closes the peer and returns false when the line passes the limit. */
  #keep(bytes: Buffer): boolean {
    if (this.#closed !== undefined) return false;
    if (this.#partialBytes + bytes.length > this.#maxLineBytes) {
      this.#log(`closing after a line longer than ${this.#maxLineBytes} bytes`);
      this.close(new Error(`received a line longer than ${this.#maxLineBytes} bytes`));
      return false;
    }
    if (bytes.length > 0) this.#partial.push(bytes);
    this.#partialBytes += bytes.length;
    return true;
  }

  #message(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // a plugin's stray print is no request, so nothing answers it
      this.#dropped++;
      return;
    }
    if (Array.isArray(message)) {
      this.#refuse(null, "batches are not supported");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.#dropped++;
      return;
    }
    const fields = message as Record<string, unknown>;
    // a message without a method is an answer, and an answer is never answered, so two peers cannot loop
    if (!("method" in fields)) {
      this.#settle(fields);
      return;
    }
    const { id, method } = fields;
    if (fields.jsonrpc !== "2.0" || typeof method !== "string" || (id !== undefined && !isId(id))) {
      this.#refuse(isId(id) ? id : null, "not a JSON-RPC 2.0 request");
      return;
    }
    if (id === undefined) void this.#notification(method, fields.params);
    else void this.#answer(id, method, fields.params);
  }

  #settle(answer: Record<string, unknown>): void {
    const pending = typeof answer.id === "number" ? this.#pending.get(answer.id) : undefined;
    if (pending === undefined) {
      this.#log(`ignored an answer to unknown request ${isId(answer.id) ? JSON.stringify(answer.id) : "null"}`);
      return;
    }
    const error = answer.error;
    if (error === undefined || error === null) pending.resolve(answer.result);
    else pending.reject(rpcErrorOf(error));
  }

  async #notification(method: string, params: unknown): Promise<void> {
    if (method === CANCEL_METHOD) {
      const id: unknown = typeof params === "object" && params !== null ? (params as { id?: unknown }).id : undefined;
      if (isId(id)) this.#running.get(id)?.abort();
      return;
    }
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      this.#log(`no handler for notification ${JSON.stringify(method)}`);
      return;
    }
    try {
      await handler(params, this.#lifetime.signal);
    } catch {
      this.#log(`notification ${JSON.stringify(method)} failed`);
    }
  }

  async #answer(id: Id, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      this.#answerError(id, method, { code: METHOD_NOT_FOUND, message: `unknown method ${method}` });
      return;
    }
    const controller = new AbortController();
    this.#running.set(id, controller);
    let line: string;
    try {
      const result = await handler(params, controller.signal);
      line = JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.#answerError(id, method, controller.signal.aborted ? cancelled(id) : wireError(error));
      return;
    } finally {
      this.#running.delete(id);
    }
    this.#write(line);
  }

  #answerError(id: Id, method: string, error: { code: number; message: string; data?: unknown }): void {
    if (this.#closed !== undefined) return;
    this.#log(`answered ${JSON.stringify(method)} request ${JSON.stringify(id)} with error ${error.code}`);
    this.#send({ jsonrpc: "2.0", id, error });
  }

  #refuse(id: Id | null, message: string): void {
    this.#log(`answered request ${JSON.stringify(id)} with error ${INVALID_REQUEST}`);
    this.#send({ jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message } });
  }

  #send(message: object): void {
    if (this.#closed === undefined) this.#write(JSON.stringify(message));
  }

  #write(line: string): void {
    if (this.#closed === undefined) this.#output.write(`${line}\n`);
  }
}

function isId(value: unknown): value is Id {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function cancelled(id: Id): { code: number; message: string } {
  return { code: CANCELLED, message: `request ${JSON.stringify(id)} was cancelled` };
}

/** A handler's own `RpcError` keeps its code; any other failure is an internal error with the error's message. */
function wireError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError) return { code: error.code, message: error.message, data: error.data };
  return { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) };
}

function rpcErrorOf(error: unknown): RpcError {
  const { code, message, data } = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  if (typeof code !== "number" || typeof message !== "string") {
    return new RpcError(INTERNAL_ERROR, "the answer held an error that is not a JSON-RPC error object");
  }
  return new RpcError(code, message, data);
}
