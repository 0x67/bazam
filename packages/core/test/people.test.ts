import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CaseSpec } from "../src/case/index.ts";
import { buildPostPlans, markdownTracker, PeopleRegistry, type PostPlanItem } from "../src/report/index.ts";
import type { CaseResult } from "../src/result/index.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "people-test-"));
});

const PEOPLE = `# account ids per tracker
roles:
  qa-lead:
    jira: jira-account-qa-lead
    notion: notion-user-qa-lead
  release-manager:
    notion: notion-user-release-manager
`;

// the first post plan item of a failed case that mentions `roles` on fail
function failedItem(people: PeopleRegistry, roles: readonly string[]): PostPlanItem | undefined {
  const spec = CaseSpec.parse({
    id: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "acceptance",
    risk: "high",
    links: ["jira:TD-246"],
    targets: ["web"],
    report: { on: { fail: { mention: roles } } },
  });
  const failed: CaseResult = {
    runId: "20261107-100000-ab12",
    caseId: "AUTH-LOGIN-001",
    title: "Customer signs in with an email code",
    stage: "acceptance",
    env: "uat",
    target: "web",
    links: ["jira:TD-246"],
    status: "fail",
    checks: [{ name: "dashboard shows the account", kind: "ui", expected: "visible", observed: "hidden", ok: false }],
    notes: [],
    followups: [],
    attachments: [],
    challenges: [],
    identities: ["customer"],
    seed: 7,
    values: {},
    startedAt: "2026-11-07T10:00:00.000Z",
    finishedAt: "2026-11-07T10:01:00.000Z",
    durationMs: 60_000,
  };
  const plan = buildPostPlans({
    runId: failed.runId,
    env: "uat",
    results: [failed],
    specs: new Map([[spec.id, spec]]),
    people,
    receipts: { latest: () => undefined },
    trackers: markdownTracker,
    transitions: { jira: { projects: { TD: { transitions: { fail: "In Progress" } } } } },
    now: new Date("2026-11-07T10:05:00Z"),
  });
  return plan.items[0];
}

describe("PeopleRegistry", () => {
  it("maps roles per tracker", async () => {
    await writeFile(join(root, "people.yaml"), PEOPLE);

    const people = await PeopleRegistry.load(root);

    expect(people.accountId("qa-lead", "jira")).toBe("jira-account-qa-lead");
    expect(people.accountId("qa-lead", "notion")).toBe("notion-user-qa-lead");
    expect(people.accountId("release-manager", "jira")).toBeUndefined();
    expect(people.accountId("designer", "jira")).toBeUndefined();
  });

  it("maps no role when the project has no people.yaml", async () => {
    const people = await PeopleRegistry.load(root);

    expect(people.accountId("qa-lead", "jira")).toBeUndefined();
  });

  it("refuses a people.yaml that maps assignee, since the ticket defines it", async () => {
    await writeFile(join(root, "people.yaml"), "roles:\n  assignee:\n    jira: jira-account-assignee\n");

    await expect(PeopleRegistry.load(root)).rejects.toThrow(/assignee and reporter come from the ticket/);
  });

  it("lists assignee, reporter and unmapped roles as unresolved", async () => {
    await writeFile(join(root, "people.yaml"), PEOPLE);

    const item = failedItem(await PeopleRegistry.load(root), ["role:assignee", "role:qa-lead", "role:reporter", "role:release-manager"]);

    expect(item?.mentions).toEqual([
      { role: "assignee" },
      { role: "qa-lead", accountId: "jira-account-qa-lead" },
      { role: "reporter" },
      { role: "release-manager" },
    ]);
    expect(item?.unresolved).toEqual(["role:assignee", "role:reporter", "role:release-manager"]);
  });

  it("lists assignee and reporter as unresolved even when the registry was built with account ids for them", () => {
    const people = new PeopleRegistry({ assignee: { jira: "jira-account-assignee" }, reporter: { jira: "jira-account-reporter" } });

    const item = failedItem(people, ["role:assignee", "role:reporter"]);

    expect(item?.mentions).toEqual([{ role: "assignee" }, { role: "reporter" }]);
    expect(item?.unresolved).toEqual(["role:assignee", "role:reporter"]);
  });
});
