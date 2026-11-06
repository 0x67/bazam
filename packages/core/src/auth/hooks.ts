import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { HttpRequestDraft, JsonValue } from "./strategy.ts";

/** Returns the headers to set on the outgoing request. */
export type AuthHook = (request: HttpRequestDraft, credential: JsonValue) => Record<string, string> | Promise<Record<string, string>>;

/**
 * Imports the default export of a project module such as `./hooks/sign.ts`. The path must resolve inside
 * the project root after following symlinks. Node strips the types of a `.ts` file outside node_modules.
 */
export async function loadAuthHook(projectRoot: string, modulePath: string): Promise<AuthHook> {
  const root = await realpath(projectRoot);
  const file = await realpath(resolve(root, modulePath));
  const fromRoot = relative(root, file);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`auth hook "${modulePath}" is outside the project root ${root}`);
  }
  const module: { default?: unknown } = await import(pathToFileURL(file).href);
  if (typeof module.default !== "function") throw new Error(`auth hook "${modulePath}" has no default export function`);
  return module.default as AuthHook;
}
