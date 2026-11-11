import { RunSupervisor } from "../../src/runs.ts";

// Stands in for the mcp command's process: it starts one run of env demo, prints the run id, and returns on the first
// Ctrl-C, as the command does. Arguments: the project root and the CLI's main script.
const [root, cliPath] = process.argv.slice(2);
if (root === undefined || cliPath === undefined)
  throw new Error("usage: host.ts <project-root> <cli-path>");
// the command waits on stdin; a timer holds this process up the same way until Ctrl-C
const serving = setInterval(() => undefined, 60_000);
process.once("SIGINT", () => clearInterval(serving));
const { runId } = await new RunSupervisor(root, cliPath).start({}, "demo", 42);
process.stdout.write(`${runId}\n`);
