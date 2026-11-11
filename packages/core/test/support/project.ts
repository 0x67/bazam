import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { PluginRegistry, type PluginManifest } from "../../src/plugin/index.ts";
import { loadProject, loadProjectConfig, type Project } from "../../src/project.ts";

export interface LoadedTestProject {
  root: string;
  project: Project;
  registry: PluginRegistry;
}

/**
 * Writes each file into a new temp folder, a value that is not a string as YAML, and loads the project the way
 * the CLI does: config, then the registry with `plugins` as defaults, then the rest. Throws on any load issue.
 */
export async function loadTestProject(
  files: Readonly<Record<string, unknown>>,
  plugins: readonly PluginManifest[],
): Promise<LoadedTestProject> {
  const root = await mkdtemp(join(tmpdir(), "run-project-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof content === "string" ? content : stringify(content));
  }
  const { config, issues } = await loadProjectConfig(root);
  if (config === undefined)
    throw new Error(`the test config has issues: ${JSON.stringify(issues)}`);
  const registry = await PluginRegistry.load(config, root, plugins);
  const project = await loadProject(root, registry);
  if (project.issues.length > 0)
    throw new Error(`the test project has issues: ${JSON.stringify(project.issues)}`);
  return { root, project, registry };
}
