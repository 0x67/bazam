import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BRAND } from "@bazam/core/brand";
import { loadProjectConfig } from "@bazam/core/project";
import type { Redactor } from "@bazam/core/redact";
import type { RunSupervisor } from "./runs.ts";
import { caseTools, ToolError, type ToolDefinition, type ToolDeps } from "./tools.ts";

// read at run time, since the package file sits outside rootDir; the path holds from src/ and dist/ alike
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** An MCP server with the case tools; every tool response passes through `redactor`. */
export function createMcpServer(deps: {
  projectRoot: string;
  supervisor: RunSupervisor;
  redactor: Redactor;
}): McpServer {
  const server = new McpServer({ name: BRAND.mcpServerName, version });
  const toolDeps = { ...deps, projectRoot: resolve(deps.projectRoot) };
  for (const tool of caseTools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, (input) =>
      callTool(tool, input, toolDeps),
    );
  }
  return server;
}

/**
 * Serves `server` over stdin and stdout until stdin ends, then closes it. Nothing else may write to `stdout` while
 * it serves, since it carries the protocol.
 */
export async function serveStdio(
  server: McpServer,
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): Promise<void> {
  const ended = Promise.withResolvers<void>();
  const end = (): void => ended.resolve();
  // the transport does not close when stdin ends, so the command would never return
  stdin.once("end", end);
  stdin.once("close", end);
  server.server.onclose = end;
  try {
    await server.connect(new StdioServerTransport(stdin, stdout));
    await ended.promise;
  } finally {
    stdin.off("end", end);
    stdin.off("close", end);
    await server.close();
  }
}

/**
 * Runs the tool and masks what it returns; a thrown error becomes a masked tool error. Each call loads its own
 * plugins, so the registries it loaded close when it ends.
 */
async function callTool(
  tool: ToolDefinition,
  input: unknown,
  shared: Omit<ToolDeps, "registries">,
): Promise<CallToolResult> {
  const deps: ToolDeps = { ...shared, registries: [] };
  const { redactor } = deps;
  try {
    // the config can change while the server runs, so each call takes the redaction rules it holds now; a config
    // that does not load keeps the rules of the last one that did, and the tools that need it report its issues
    const { config } = await loadProjectConfig(deps.projectRoot);
    if (config !== undefined) redactor.configure(config.redaction);
    const reply = await tool.handle(input as Parameters<ToolDefinition["handle"]>[0], deps);
    const text =
      reply.masking === "registered" ? redactor.maskRegistered(json(reply.doc)) : json(redactor.value(reply.doc));
    const images = (reply.images ?? []).flatMap(({ name, data, mimeType }) => [
      { type: "text" as const, text: redactor.text(name) },
      { type: "image" as const, data, mimeType },
    ]);
    return { content: [{ type: "text", text }, ...images] };
  } catch (error) {
    // the SDK would send the message as it is, and it may quote an input or a file
    return { isError: true, content: [{ type: "text", text: redactor.text(errorText(error)) }] };
  } finally {
    await Promise.all(deps.registries.map((registry) => registry.close()));
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const issues = error instanceof ToolError ? error.issues : [];
  return [
    message,
    ...issues.map((i) => `${i.file}:${i.line}: ${i.severity} ${i.ruleId}: ${i.message}\n  fix: ${i.fix}`),
  ].join("\n");
}

function json(doc: unknown): string {
  return JSON.stringify(doc, null, 2);
}
