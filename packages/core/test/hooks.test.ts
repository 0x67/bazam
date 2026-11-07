import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadAuthHook } from "../src/auth/index.ts";

const run = promisify(execFile);

const SIGN_HOOK = `
interface Draft { method: string; url: URL }
export default (request: Draft, credential: { keyId: string }): Record<string, string> => ({
  "X-Signature": \`\${request.method} \${request.url.pathname} \${credential.keyId}\`,
});
`;

describe("loadAuthHook", () => {
  let dir: string;
  let project: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hooks-test-"));
    project = join(dir, "project");
    await mkdir(join(project, "hooks"), { recursive: true });
    await writeFile(join(dir, "outside.ts"), SIGN_HOOK);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // plain Node, not the test runner's transform, so the run's own type stripping loads the hook
  it("loads a .ts hook inside the root and returns the headers its default export gives", async () => {
    await writeFile(join(project, "hooks", "sign.ts"), SIGN_HOOK);
    const caller = `
      const { loadAuthHook } = await import(process.argv[1]);
      const hook = await loadAuthHook(process.argv[2], "./hooks/sign.ts");
      const request = { method: "POST", url: new URL("https://api.example.test/orders"), headers: new Headers() };
      process.stdout.write(JSON.stringify(await hook(request, { keyId: "fake-key-id" })));
    `;
    const hooksModule = new URL("../src/auth/hooks.ts", import.meta.url).href;

    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", caller, hooksModule, project]);

    expect(JSON.parse(stdout)).toEqual({ "X-Signature": "POST /orders fake-key-id" });
  });

  it("refuses a hook outside the root", async () => {
    await expect(loadAuthHook(project, "../outside.ts")).rejects.toThrow('auth hook "../outside.ts" is outside the project root');
  });

  // creating a symlink on Windows needs extra privileges
  it.skipIf(process.platform === "win32")("refuses a hook inside the root that links to a file outside it", async () => {
    await symlink(join(dir, "outside.ts"), join(project, "hooks", "sign.ts"));

    await expect(loadAuthHook(project, "./hooks/sign.ts")).rejects.toThrow('auth hook "./hooks/sign.ts" is outside the project root');
  });

  it("refuses a module whose default export is not a function", async () => {
    await writeFile(join(project, "hooks", "headers.ts"), 'export default { "X-Signature": "fake-signature" };\n');

    await expect(loadAuthHook(project, "./hooks/headers.ts")).rejects.toThrow('auth hook "./hooks/headers.ts" has no default export function');
  });
});
