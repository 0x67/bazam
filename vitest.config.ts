import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      // Workspace packages resolve to their TypeScript sources, so tests need no
      // build, also when NODE_ENV=production.
      conditions: ["node", "development"],
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
