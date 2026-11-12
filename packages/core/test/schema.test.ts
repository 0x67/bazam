import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { BRAND } from "../src/brand.ts";
import {
  buildCaseSchema,
  CASE_ID,
  CaseSpec,
  caseJsonSchema,
  STEP_LISTS,
  stepKind,
} from "../src/case/index.ts";
import {
  declaredSecretNames,
  loadProjectConfig,
  resultLineOf,
  runnerOf,
  type ConfigLoad,
} from "../src/project.ts";

const minimal = {
  id: "AUTH-LOGIN-001",
  title: "Customer signs in",
  stage: "draft",
  risk: "low",
  targets: ["web"],
};

const tap = { kind: "tap", schema: z.strictObject({ id: z.string() }) };

function issuePaths(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

function issueMessages(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("CaseSpec", () => {
  it("fills defaults for the optional list and flag fields", () => {
    expect(CaseSpec.parse(minimal)).toEqual({
      ...minimal,
      links: [],
      needs: [],
      tags: [],
      once: false,
      prod_safe: false,
      steps: [],
      checks: [],
      finally: [],
    });
  });

  it("takes ids with at most 7 digits in a row, since the redactor masks longer runs", () => {
    for (const id of [
      "AUTH-LOGIN-001",
      "AUTH-LOGIN-1234567",
      "A1B2-C3D4567-0001",
      "SMOKE-JIRA261110-060129",
    ])
      expect(CASE_ID.test(id), id).toBe(true);
    for (const id of [
      "AUTH-LOGIN-01",
      "AUTH-LOGIN-12345678",
      "PAY-REFUND20261110-001",
      "A12345678-LOGIN-001",
    ])
      expect(CASE_ID.test(id), id).toBe(false);
    expect(issueMessages(CaseSpec, { ...minimal, id: "AUTH-LOGIN-12345678" })).toEqual([
      "an id looks like DOMAIN-AREA-NNN, for example AUTH-LOGIN-001, with 3 to 7 digits at the end and no more than 7 digits in a row",
    ]);
  });

  it("accepts every field with a valid value", () => {
    const full = {
      ...minimal,
      stage: "acceptance",
      risk: "high",
      links: ["jira:DEMO-246"],
      needs: ["passkey"],
      tags: ["smoke"],
      once: true,
      prod_safe: true,
      steps: [
        { use: "login" },
        {
          request: {
            method: "POST",
            url: "${env.API_URL}/orders",
            as: "customer",
            json: { amount: 1 },
            write: true,
            save: { orderId: "body.id" },
          },
        },
        {
          challenge: {
            kind: "otp-email",
            trigger: { note: "send" },
            fill: { id: "otp-input" },
            params: { recipient: "a@example.test" },
          },
          as: "customer",
        },
        {
          guided: {
            title: "Confirm with face",
            steps: ["Look at the camera"],
            expected: "Dashboard",
            observe: { note: "check" },
          },
        },
        { note: "done" },
      ],
      checks: [{ request: { method: "GET", url: "${env.API_URL}/me" } }],
      finally: [{ request: { method: "DELETE", url: "${env.API_URL}/fault", write: true } }],
      report: {
        comment: "update",
        on: { pass: { transition: "Ready for Release", mention: ["role:qa-lead"] } },
      },
    };

    expect(CaseSpec.safeParse(full).success).toBe(true);
  });

  it.each([
    ["id", "auth-login-1"],
    ["title", ""],
    ["stage", "done"],
    ["risk", "critical"],
    ["links", ["DEMO-246"]],
    ["targets", []],
    ["needs", [1]],
    ["tags", "smoke"],
    ["once", "yes"],
    ["prod_safe", 1],
    ["steps", "open the app"],
    ["checks", {}],
    ["finally", "delete the fault"],
    ["report", { comment: "edit" }],
  ])("rejects an invalid %s with an issue on that field", (field, value) => {
    expect(issuePaths(CaseSpec, { ...minimal, [field]: value })[0]?.split(".")[0]).toBe(field);
  });

  it.each(["id", "title", "stage", "risk", "targets"])("rejects a case without %s", (field) => {
    const { [field as keyof typeof minimal]: _, ...rest } = minimal;

    expect(issuePaths(CaseSpec, rest)).toEqual([field]);
  });

  it("rejects an unknown case field", () => {
    expect(issueMessages(CaseSpec, { ...minimal, owner: "qa" })).toEqual([
      'Unrecognized key: "owner"',
    ]);
  });
});

describe("STEP_LISTS", () => {
  it("names every list of steps a case holds, in the order they run", () => {
    const spec = CaseSpec.parse(minimal);

    expect(STEP_LISTS).toEqual(["steps", "checks", "finally"]);
    expect(STEP_LISTS.every((list) => Array.isArray(spec[list]))).toBe(true);
  });
});

describe("buildCaseSchema", () => {
  it("rejects an unknown step kind and lists the known kinds, plugin kinds included", () => {
    const schema = buildCaseSchema([tap]);

    expect(issuePaths(schema, { ...minimal, steps: [{ hover: { id: "menu" } }] })).toEqual([
      "steps.0.hover",
    ]);
    expect(issueMessages(schema, { ...minimal, steps: [{ hover: { id: "menu" } }] })).toEqual([
      'unknown step kind "hover"; known kinds: challenge, followup, guided, note, request, tap, use',
    ]);
  });

  it("takes a followup step with a name and a hint and refuses anything else", () => {
    const schema = buildCaseSchema([]);
    const followup = (payload: unknown) => ({ ...minimal, checks: [{ followup: payload }] });

    for (const list of ["checks", "steps", "finally"])
      expect(
        schema.safeParse({ ...minimal, [list]: [{ followup: { name: "badge", hint: "look" } }] })
          .success,
      ).toBe(true);
    expect(issuePaths(schema, followup({ name: "badge", hint: "" }))).toEqual([
      "checks.0.followup.hint",
    ]);

    expect(schema.safeParse(followup({ name: "badge", hint: "look at it" })).success).toBe(true);
    expect(schema.safeParse(followup({ name: "badge" })).success).toBe(false);
    expect(schema.safeParse(followup({ name: "", hint: "look" })).success).toBe(false);
    expect(schema.safeParse(followup({ name: "badge", hint: "look", extra: 1 })).success).toBe(
      false,
    );
  });

  it("accepts a plugin step kind with an identity", () => {
    const parsed = buildCaseSchema([tap]).parse({
      ...minimal,
      steps: [{ tap: { id: "sign-in" }, as: "customer" }],
    });

    expect(parsed.steps).toEqual([{ tap: { id: "sign-in" }, as: "customer" }]);
  });

  it("lets a plugin schema replace the core schema of the same kind", () => {
    const schema = buildCaseSchema([{ kind: "note", schema: z.number() }]);

    expect(schema.safeParse({ ...minimal, steps: [{ note: 3 }] }).success).toBe(true);
    expect(schema.safeParse({ ...minimal, steps: [{ note: "text" }] }).success).toBe(false);
  });

  it("returns the plugin schema's output for its step", () => {
    const shout = { kind: "shout", schema: z.string().transform((text) => ({ text })) };

    expect(buildCaseSchema([shout]).parse({ ...minimal, steps: [{ shout: "hi" }] }).steps).toEqual([
      { shout: { text: "hi" } },
    ]);
  });

  it.each([
    [
      "two kind keys",
      { note: "a", request: { method: "GET", url: "u" } },
      "a step has exactly one kind key, found note, request",
    ],
    ["no kind key", { as: "customer" }, "a step has exactly one kind key, found none"],
    [
      "a plain string",
      "open the app",
      "a step is a mapping with one kind key, such as `note: text`",
    ],
  ])("rejects a step with %s", (_, step, message) => {
    expect(issueMessages(CaseSpec, { ...minimal, steps: [step] })).toEqual([message]);
  });

  it("points issues inside a step at the payload field, also in nested trigger steps", () => {
    const steps = [
      { request: { method: "GET", url: 42 } },
      { request: { method: "GET", url: "u", body: "x" } },
      { challenge: { kind: "totp", trigger: { tap: { id: 7 } } } },
    ];

    expect(issuePaths(buildCaseSchema([tap]), { ...minimal, steps })).toEqual([
      "steps.0.request.url",
      "steps.1.request.body",
      "steps.2.challenge.trigger.tap.id",
    ]);
  });
});

describe("step marks", () => {
  const schema = buildCaseSchema([tap]);
  const marks = { level: "core", callout: true };
  const kinds: [string, unknown][] = [
    ["use", "login"],
    ["request", { method: "GET", url: "/health" }],
    ["challenge", { kind: "otp" }],
    ["guided", { title: "look", steps: ["open it"] }],
    ["note", "seen"],
    ["followup", { name: "badge", hint: "look" }],
    ["tap", { id: "menu" }],
  ];

  it.each(kinds)("takes level and callout beside a %s step", (kind, payload) => {
    const parsed = schema.safeParse({ ...minimal, checks: [{ [kind]: payload, ...marks }] });

    expect(parsed.success).toBe(true);
  });

  it("refuses a level of two words, a level of 21 characters and a callout that is not a boolean", () => {
    const refused = (mark: object) =>
      schema.safeParse({ ...minimal, checks: [{ note: "seen", ...mark }] }).success;

    expect(refused({ level: "two words" })).toBe(false);
    expect(refused({ level: "a".repeat(21) })).toBe(false);
    expect(refused({ level: "a".repeat(20) })).toBe(true);
    expect(refused({ callout: "yes-please" })).toBe(false);
  });

  it("names the form of a level", () => {
    expect(
      issueMessages(schema, { ...minimal, checks: [{ note: "seen", level: "two words" }] }),
    ).toContain("a level takes 1 to 20 letters, digits and dashes, such as core");
  });

  it("keeps one kind key when a step carries marks, and still refuses two", () => {
    expect(stepKind({ api: { method: "GET" }, as: "alice", ...marks })).toBe("api");
    expect(
      schema.safeParse({ ...minimal, checks: [{ note: "seen", tap: { id: "menu" }, ...marks }] })
        .success,
    ).toBe(false);
  });
});

describe("caseJsonSchema", () => {
  const json = caseJsonSchema(buildCaseSchema([tap])) as {
    properties: {
      cases: { items: { required: string[]; properties: Record<string, { pattern?: string }> } };
    };
    $defs: Record<string, { anyOf?: { required: string[] }[] }>;
  };
  const item = json.properties.cases.items;

  it("describes a case file whose cases require only the fields without defaults", () => {
    expect(item.required).toEqual(["id", "title", "stage", "risk", "targets"]);
    expect(item.properties["id"]?.pattern).toBe(CASE_ID.source);
  });

  it("lists every step kind, plugin kinds included, as one anyOf branch", () => {
    const stepBranches =
      Object.values(json.$defs).find((def) => def.anyOf !== undefined)?.anyOf ?? [];

    expect(
      stepBranches
        .map((branch) => branch.required)
        .sort((a, b) => a.join().localeCompare(b.join())),
    ).toEqual([["challenge"], ["followup"], ["guided"], ["note"], ["request"], ["tap"], ["use"]]);
  });
});

describe("runner targets and process plugin entries", () => {
  const PLAIN_NAME_RULE =
    "letters, digits, dots, dashes and underscores, starting with a letter or digit";
  const roots: string[] = [];
  const runner = [
    "envs: {}",
    "identities:",
    "  customer: {}",
    "runners:",
    "  shop-selenium:",
    "    command: [mvn, -q, test]",
    "    results: target/surefire-reports/*.xml",
    "    format: junit",
  ];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function load(lines: readonly string[]): Promise<ConfigLoad> {
    const root = await mkdtemp(join(tmpdir(), "schema-test-"));
    roots.push(root);
    await writeFile(join(root, BRAND.configFile), `${lines.join("\n")}\n`);
    return loadProjectConfig(root);
  }

  /** [line, message] of each issue. */
  async function issues(lines: readonly string[]): Promise<[number, string][]> {
    return (await load(lines)).issues.map((issue) => [issue.line, issue.message]);
  }

  it("lists the declared secret names once: secrets.names, tracker secrets, then identity references", async () => {
    const { config, issues } = await load([
      "envs: {}",
      "secrets:",
      "  names: [SHOP_PASSWORD, JIRA_EMAIL]",
      "identities:",
      "  customer:",
      "    auth:",
      "      web:",
      "        strategy: cookie",
      '        with: { password: "${secret.CUSTOMER_PASSWORD}", note: "${env.APP_URL} ${secret.SHOP_PASSWORD}" }',
      "trackers:",
      "  jira:",
      "    secrets: { email: JIRA_EMAIL, token: JIRA_API_TOKEN }",
    ]);

    if (config === undefined) throw new Error(`the config has issues: ${JSON.stringify(issues)}`);
    expect(declaredSecretNames(config)).toEqual([
      "SHOP_PASSWORD",
      "JIRA_EMAIL",
      "JIRA_API_TOKEN",
      "CUSTOMER_PASSWORD",
    ]);
  });

  it("loads runners, runner targets, a process plugin entry and the new tracker fields", async () => {
    const { config, issues } = await load([
      ...runner,
      "    identities: [customer]",
      "targets:",
      "  web: { driver: playwright, browser: chromium }",
      "  shop-chrome: { runner: shop-selenium, env: { BROWSER: chrome } }",
      "trackers:",
      "  jira:",
      "    site: example.atlassian.net",
      "    api: https://api.atlassian.com/ex/jira/0f3e2d1c",
      "    secrets: { email: JIRA_EMAIL, token: JIRA_API_TOKEN }",
      "    projects:",
      "      DEMO:",
      "        bugs: { issueType: Bug, labels: [regression] }",
      "        promoteOn: [Done, Released]",
      "plugins:",
      "  - ./plugins/local-steps.ts",
      "  - { command: [python3, plugins/otp_hook.py], timeoutSeconds: 120 }",
    ]);

    if (config === undefined) throw new Error(`the config has issues: ${JSON.stringify(issues)}`);

    expect(config.runners["shop-selenium"]?.prodSafe).toBe(false);
    expect(config.targets["web"]).toEqual({ driver: "playwright", browser: "chromium" });
    expect(runnerOf(config, "shop-chrome")).toEqual({
      name: "shop-selenium",
      runner: config.runners["shop-selenium"],
      env: { BROWSER: "chrome" },
    });
    expect(runnerOf(config, "web")).toBeUndefined();
    expect(config.plugins[1]).toEqual({
      command: ["python3", "plugins/otp_hook.py"],
      cwd: ".",
      env: {},
      timeoutSeconds: 120,
    });
    expect(config.trackers["jira"]?.projects["DEMO"]?.bugs).toEqual({
      issueType: "Bug",
      labels: ["regression"],
      linkType: "Relates",
    });
  });

  it("accepts only a boolean for prodSafe", async () => {
    expect(await issues([...runner, "    prodSafe: yes"])).toEqual([
      [9, "runners.shop-selenium.prodSafe: Invalid input: expected boolean, received string"],
    ]);
  });

  it("takes a timeoutMinutes up to the longest timer Node can set", async () => {
    const { config } = await load([...runner, "    timeoutMinutes: 35791"]);
    expect(config?.runners["shop-selenium"]?.timeoutMinutes).toBe(35791);
    expect(await issues([...runner, "    timeoutMinutes: 35792"])).toEqual([
      [
        9,
        "runners.shop-selenium.timeoutMinutes: timeoutMinutes can be at most 35791 (about 24.8 days), the longest timer Node can set",
      ],
    ]);
  });

  it("refuses a runner identity the config does not define, on its line", async () => {
    expect(
      await issues([...runner, "    identities:", "      - customer", "      - admin"]),
    ).toEqual([
      [
        11,
        "runners.shop-selenium.identities[1]: runner shop-selenium lists identity admin, which is not defined under identities",
      ],
    ]);
  });

  it("refuses a target that names both a driver and a runner", async () => {
    expect(
      await issues([...runner, "targets:", "  web: { driver: playwright, runner: shop-selenium }"]),
    ).toEqual([[10, "targets.web: a target names a driver or a runner, not both"]]);
  });

  it.each([["shop-selenum"], ["toString"]])(
    "refuses a runner target that names the unknown runner %s",
    async (name) => {
      expect(await issues([...runner, "targets:", `  shop-chrome: { runner: ${name} }`])).toEqual([
        [10, `targets.shop-chrome.runner: runner ${name} is not defined under runners`],
      ]);
    },
  );

  it("refuses a runner identity named after an Object property", async () => {
    expect(await issues([...runner, "    identities: [constructor]"])).toEqual([
      [
        9,
        "runners.shop-selenium.identities[0]: runner shop-selenium lists identity constructor, which is not defined under identities",
      ],
    ]);
  });

  it("reports a runner target's env value that is not a string", async () => {
    expect(
      await issues([
        ...runner,
        "targets:",
        "  shop-chrome: { runner: shop-selenium, env: { PORT: 8080 } }",
      ]),
    ).toEqual([
      [10, "targets.shop-chrome: env.PORT: Invalid input: expected string, received number"],
    ]);
  });

  it.each([
    ["runner", ["targets:", '  shop-chrome: { runner: "" }'], 10, "targets.shop-chrome.runner"],
    ["identity", ['    identities: [""]'], 9, "runners.shop-selenium.identities[0]"],
  ])("reports an empty %s once", async (_, lines, line, path) => {
    expect(await issues([...runner, ...lines])).toEqual([
      [line, `${path}: Too small: expected string to have >=1 characters`],
    ]);
  });

  it.each([["{ command: python3 x.py }"], ["{ comand: [python3, x.py] }"]])(
    "refuses the plugin entry %s",
    async (entry) => {
      expect(await issues(["envs: {}", "plugins:", `  - ${entry}`])).toEqual([
        [
          3,
          "plugins[0]: a plugin entry is a module path, or an object whose command is an argv list such as [python3, plugins/otp_hook.py]",
        ],
      ]);
    },
  );

  it("refuses a plugin timeoutSeconds longer than a Node timer holds and takes the longest one it holds", async () => {
    const entry = (seconds: number) => [
      "envs: {}",
      "plugins:",
      `  - { command: [python3, x.py], timeoutSeconds: ${seconds} }`,
    ];

    expect(await issues(entry(2_147_484))).toEqual([
      [
        3,
        "plugins[0].timeoutSeconds: timeoutSeconds takes at most 2147483 (about 24 days), the longest delay a Node timer holds",
      ],
    ]);
    expect((await load(entry(2_147_483))).config?.plugins[0]).toMatchObject({
      timeoutSeconds: 2_147_483,
    });
  });

  it.each([[".."], ["shop/chrome"]])("refuses a runner target named %s", async (name) => {
    expect(await issues([...runner, "targets:", `  "${name}": { runner: shop-selenium }`])).toEqual(
      [[10, `targets.${name}: a runner target's name takes ${PLAIN_NAME_RULE}`]],
    );
  });

  it.each([["shop selenium"], ["../shop"]])("refuses a runner named %s", async (name) => {
    expect(
      await issues(runner.map((line) => line.replace("shop-selenium:", `"${name}":`))),
    ).toEqual([[5, `runners.${name}: a runner name takes ${PLAIN_NAME_RULE}`]]);
  });

  it.each([
    ["a scheme", "https://example.atlassian.net"],
    ["a path", "example.atlassian.net/jira"],
    ["a fragment", "example.atlassian.net#comments"],
    ["a query", "example.atlassian.net?x=1"],
    ["credentials", "ops@example.atlassian.net"],
    ["no host", ""],
    ["an uppercase host", "Example.atlassian.net"],
    ["the default port", "example.atlassian.net:443"],
  ])("refuses a tracker site with %s", async (_, site) => {
    expect(await issues(["envs: {}", "trackers:", "  jira:", `    site: "${site}"`])).toEqual([
      [
        4,
        "trackers.jira.site: site takes a lowercase host and an optional port other than 443, such as example.atlassian.net, with no scheme, credentials, path, query or fragment",
      ],
    ]);
  });

  it("allows an http api only on 127.0.0.1 or localhost with a port", async () => {
    const api = (url: string) => [
      "envs: {}",
      "trackers:",
      "  jira:",
      "    site: 127.0.0.1:8080",
      `    api: ${url}`,
    ];
    const refused = [
      5,
      "trackers.jira.api: api must be an https URL; http only for 127.0.0.1 or localhost with a port",
    ];

    expect(await issues(api("http://127.0.0.1:8080/rest"))).toEqual([]);
    expect(await issues(api("http://localhost:8080"))).toEqual([]);
    expect(await issues(api("http://127.0.0.1/rest"))).toEqual([refused]);
    expect(await issues(api("http://api.example.test:8080"))).toEqual([refused]);
    expect(await issues(api("not a url"))).toEqual([[5, "trackers.jira.api: Invalid URL"]]);
  });

  it("refuses a result line with an unknown field or a stray brace, on its line", async () => {
    const jira = (resultLine: string) => [
      "trackers:",
      "  jira:",
      `    resultLine: "${resultLine}"`,
    ];

    expect(await issues(["envs: {}", ...jira("{status} on {enviroment}")])).toEqual([
      [
        4,
        "trackers.jira.resultLine: unknown field {enviroment}; the fields are status, env, date, identities, case, title, run, target",
      ],
    ]);
    expect(await issues(["envs: {}", ...jira("{status} on {env")])).toEqual([
      [4, "trackers.jira.resultLine: a { or } that is not part of a field"],
    ]);
    expect(await issues(["envs: {}", ...jira("{status} on {env} {date}")])).toEqual([]);
  });

  it("gives the result line of its own tracker only", async () => {
    const { config } = await load([
      "envs: {}",
      "trackers:",
      "  jira:",
      '    resultLine: "{status} on {env}"',
      "  linear: {}",
    ]);
    if (config === undefined) throw new Error("the config has issues");

    expect(resultLineOf(config, "jira")).toBe("{status} on {env}");
    expect(resultLineOf(config, "linear")).toBeUndefined();
    expect(resultLineOf(config, "notion")).toBeUndefined();
    const inherited = { ...config, trackers: Object.create({ jira: { resultLine: "{env}" } }) };
    expect(resultLineOf(inherited, "jira")).toBeUndefined();
  });
});
