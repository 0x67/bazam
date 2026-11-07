import { createMcpServer, RunSupervisor, serveStdio } from "@bazam/mcp";
import { ExitCode } from "../exit.ts";
import type { CommandContext } from "../main.ts";

/**
 * Serves the MCP tools for the project at --root on stdin and stdout until stdin ends or Ctrl-C. The protocol owns
 * stdout, so the command writes nothing there and logs only to stderr. `cliPath` is the CLI's main script, which
 * run_start spawns.
 */
export async function mcpCommand(ctx: CommandContext, cliPath: string): Promise<ExitCode> {
  const server = createMcpServer({
    projectRoot: ctx.root,
    supervisor: new RunSupervisor(ctx.root, cliPath),
    redactor: ctx.redactor,
  });
  // runs started here are detached, so they go on after the server closes
  const stop = (): void => void server.close();
  ctx.io.signal.addEventListener("abort", stop, { once: true });
  ctx.out.log(`serving the MCP tools for ${ctx.root} on stdio`);
  try {
    await serveStdio(server);
  } finally {
    ctx.io.signal.removeEventListener("abort", stop);
  }
  return ExitCode.Pass;
}
