import { defineConfig } from "vite-plus";

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
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
      // Oxlint reports its rules as warnings by default; this makes a warning fail vp lint and vp check,
      // so the Git hooks refuse it too
      denyWarnings: true,
    },
  },
  fmt: {
    printWidth: 100,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    useTabs: false,
    // keep package.json key order as written
    sortPackageJson: false,
    // leave html`` templates as written; formatting them changes the markup the demo app serves
    embeddedLanguageFormatting: "off",
    // fixture layout is test data: the check tests assert line numbers in these files
    ignorePatterns: ["pnpm-lock.yaml", "packages/*/test/fixtures/**"],
    overrides: [
      // the demo app is written without semicolons
      { files: ["examples/demo-app/**"], options: { semi: false } },
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
});
