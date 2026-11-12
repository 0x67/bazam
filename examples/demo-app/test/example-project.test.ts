import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vite-plus/test"
// waits until the demo and Mailpit answer, since the runs below go through them
import "./support/demo.ts"

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const EXAMPLES = join(REPO_ROOT, "examples")
// the CLI from its sources, so the tests need no build
const CLI = join(REPO_ROOT, "packages/cli/src/main.ts")

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function cli(args: readonly string[], cwd = REPO_ROOT): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--conditions=development", CLI, ...args],
      { cwd },
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string }
    if (typeof failed.code !== "number") throw error
    return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" }
  }
}

const copies: string[] = []

afterEach(async () => {
  for (const copy of copies.splice(0)) await rm(copy, { recursive: true, force: true })
})

// what a fresh clone holds of the example project: the files git does not ignore, without the demo app,
// in a folder outside any repository
async function cloneOfExamples(): Promise<string> {
  const { stdout } = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: EXAMPLES,
    },
  )
  const copy = await mkdtemp(join(tmpdir(), "example-project-"))
  copies.push(copy)
  for (const file of stdout.split("\0")) {
    if (file === "" || file.startsWith("demo-app/")) continue
    await mkdir(dirname(join(copy, file)), { recursive: true })
    await copyFile(join(EXAMPLES, file), join(copy, file))
  }
  return copy
}

interface RunSummary {
  runId: string
}

interface CaseResult {
  status: string
  checks: { name: string; ok: boolean; level?: string; callout?: boolean }[]
  steps: { number: number; kind: string; list: string; durationMs: number }[]
  identities: string[]
}

// a copy of the examples that holds the fixtures a run reads
async function copyForRuns(): Promise<string> {
  const copy = await cloneOfExamples()
  await copyFile(
    join(copy, "fixtures/identities.example.yaml"),
    join(copy, "fixtures/identities.local.yaml"),
  )
  return copy
}

// the demo's secrets, when the repository holds them
async function copySecrets(copy: string): Promise<void> {
  const demoSecrets = await readFile(join(EXAMPLES, ".bazam/secrets.env"), "utf8").catch(
    () => undefined,
  )
  if (demoSecrets === undefined) return
  await mkdir(join(copy, ".bazam"), { recursive: true })
  await writeFile(join(copy, ".bazam/secrets.env"), demoSecrets, { mode: 0o600 })
}

async function resultOf(copy: string, stdout: string, caseId: string): Promise<CaseResult> {
  const { runId } = JSON.parse(stdout) as RunSummary
  return JSON.parse(
    await readFile(join(copy, "runs", runId, caseId, "result.json"), "utf8"),
  ) as CaseResult
}

describe("example project", () => {
  it("passes check in a copy outside the repository, where only its own .gitignore counts", async () => {
    const copy = await cloneOfExamples()

    const result = await cli(["check", "--root", copy])

    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining("0 errors") })
  })

  it("fails PROFILE-PHONE-001 when the demo refuses a save, also after an earlier run saved the number", async () => {
    const copy = await cloneOfExamples()
    await copyFile(
      join(copy, "fixtures/identities.example.yaml"),
      join(copy, "fixtures/identities.local.yaml"),
    )
    const phoneRun = [
      "run",
      "--root",
      copy,
      "--env",
      "demo",
      "--case",
      "PROFILE-PHONE-001",
      "--json",
    ]
    expect((await cli(phoneRun)).code).toBe(0)
    // the demo refuses this number and shows the page again with whatever the account saved before
    const file = join(copy, "cases/profile/phone.yaml")
    const written = await readFile(file, "utf8")
    const refused = written.replace(/(\{ id: search-number \}, value: )"[^"]*"/, '$1"abc"')
    expect(refused).not.toBe(written)
    await writeFile(file, refused)

    const { code, stdout } = await cli(phoneRun)

    const result = await resultOf(copy, stdout, "PROFILE-PHONE-001")
    expect(code).toBe(1)
    expect(result.status).toBe("fail")
    expect(result.checks.find((check) => check.name.includes("search-saved"))?.ok).toBe(false)
  }, 60_000)

  it("ends AUTH-FOLLOWUP-001 followup and exits 3", async () => {
    const copy = await copyForRuns()

    const { code, stdout } = await cli([
      "run",
      "--root",
      copy,
      "--env",
      "demo",
      "--case",
      "AUTH-FOLLOWUP-001",
      "--json",
    ])

    expect(code).toBe(3)
    expect((await resultOf(copy, stdout, "AUTH-FOLLOWUP-001")).status).toBe("followup")
  }, 60_000)

  it("runs AUTH-ROLE-001 as the identity --as gives the role", async () => {
    const copy = await copyForRuns()
    const runRole = ["run", "--root", copy, "--env", "demo", "--case", "AUTH-ROLE-001", "--json"]

    const byDefault = await cli(runRole)
    const asTeammate = await cli([...runRole, "--as", "tester=teammate"])

    expect(byDefault.code).toBe(0)
    expect((await resultOf(copy, byDefault.stdout, "AUTH-ROLE-001")).identities).toEqual([
      "customer",
    ])
    expect(asTeammate.code).toBe(0)
    expect((await resultOf(copy, asTeammate.stdout, "AUTH-ROLE-001")).identities).toEqual([
      "teammate",
    ])
  }, 90_000)

  it("scans an acceptance run clean and lists the example identities in doctor", async () => {
    const copy = await copyForRuns()
    await copySecrets(copy)
    const answers = join(copy, "fixtures/answers")
    const runAcceptance = [
      "run",
      "--root",
      copy,
      "--env",
      "demo",
      "--suite",
      "acceptance",
      "--target",
      "web",
    ]
    const ran = await cli([
      ...runAcceptance,
      "--channel",
      "answers-file",
      "--answers",
      answers,
      "--json",
    ])
    const { runId } = JSON.parse(ran.stdout) as RunSummary

    const scan = await cli(["scan", "--root", copy, "--run", runId])
    const doctor = await cli(["doctor", "--root", copy, "--env", "demo"])

    expect(ran.code).toBe(0)
    expect(scan).toMatchObject({ code: 0, stdout: expect.stringContaining("0 findings") })
    expect(doctor.stdout).toMatch(/customer\.email: email, example domain/)
    expect(doctor.stdout).toMatch(/teammate\.email: email, example domain/)
    expect(doctor.stdout).toContain("customer.phone: phone, country United Kingdom")
    const fixtures = await readFile(join(copy, "fixtures/identities.local.yaml"), "utf8")
    const values = [...fixtures.matchAll(/^\s+\w+: "?([^"\n]+)"?$/gm)].map(
      (match) => match[1] ?? "",
    )
    expect(values.length).toBeGreaterThan(0)
    for (const value of [...values, "2468", "demo-api-key"])
      expect(doctor.stdout).not.toContain(value)
    expect(doctor.code).toBe(0)
  }, 90_000)

  it("records the marks and step times of API-KEY-001 and words its post plan with the result line", async () => {
    const copy = await copyForRuns()
    await copySecrets(copy)

    const { code, stdout } = await cli([
      "run",
      "--root",
      copy,
      "--env",
      "demo",
      "--case",
      "API-KEY-001",
      "--json",
    ])

    const result = await resultOf(copy, stdout, "API-KEY-001")
    expect(code).toBe(0)
    expect(result.checks.map((check) => check.level)).toEqual(["core", undefined])
    expect(result.checks.map((check) => check.callout)).toEqual([undefined, true])
    expect(result.steps.length).toBeGreaterThan(0)
    expect(result.steps.map((step) => step.number)).toEqual(
      result.steps.map((_step, index) => index + 1),
    )
    const { runId } = JSON.parse(stdout) as RunSummary
    const plan = JSON.parse(
      await readFile(join(copy, "runs", runId, "post-plan.json"), "utf8"),
    ) as {
      items: { comment: { markdown: string } }[]
    }
    expect(plan.items[0]?.comment.markdown).toMatch(
      /^\*\*Passed\*\* in demo on \d{4}-\d{2}-\d{2}: API-KEY-001 Partner API accepts the API key\n/,
    )
  }, 60_000)

  it("shows the role binding in plan", async () => {
    const result = await cli([
      "plan",
      "--root",
      EXAMPLES,
      "--env",
      "demo",
      "--as",
      "tester=teammate",
    ])

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("roles: tester=teammate"),
    })
  })

  it("runs the otp client with the command its header documents, from the repository root", async () => {
    const source = await readFile(join(EXAMPLES, "clients/otp-client.mjs"), "utf8")
    // the documented line is the CLI name followed by its arguments
    const documented = /^\/\/ {3}\S+ (exec .+)$/m.exec(source)?.[1]
    expect(documented).toBeDefined()

    const result = await cli(documented?.split(" ") ?? [])

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/got a 6-character code/),
    })
  }, 30_000)
})
