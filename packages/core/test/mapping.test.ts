import { describe, expect, it } from "vite-plus/test";
import { CaseSpec } from "../src/case/index.ts";
import type { ExternalTest } from "../src/ingest/format.ts";
import { mapTests, testTitle, type MappingInputs } from "../src/ingest/mapping.ts";

const TARGET = "shop-chrome";

function caseSpec(id: string, targets: string[] = [TARGET]): CaseSpec {
  return CaseSpec.parse({
    id,
    title: `Title of ${id}`,
    stage: "acceptance",
    risk: "medium",
    targets,
  });
}

function externalTest(title: string[], extra: Partial<ExternalTest> = {}): ExternalTest {
  return {
    title,
    tags: [],
    outcome: "passed",
    retries: 0,
    attachments: [],
    source: "results/junit.xml",
    ...extra,
  };
}

function inputs(tests: ExternalTest[], extra: Partial<MappingInputs> = {}): MappingInputs {
  const cases = [
    caseSpec("SHOP-CART-001"),
    caseSpec("SHOP-CART-002"),
    caseSpec("SHOP-PAY-001", ["shop-firefox"]),
  ];
  return {
    target: TARGET,
    tests,
    cases: new Map(cases.map((spec) => [spec.id, spec])),
    selected: new Set(["SHOP-CART-001", "SHOP-CART-002"]),
    ...extra,
  };
}

// entries rather than an object, so the assertions also check the order
function byCase(mapped: ReturnType<typeof mapTests>): [string, string[]][] {
  return [...mapped.byCase].map(([id, tests]) => [id, tests.map(testTitle)]);
}

describe("testTitle", () => {
  it("joins the title with › and puts the Playwright project in front", () => {
    expect(testTitle(externalTest(["cart.spec.ts", "cart", "keeps items"]))).toBe(
      "cart.spec.ts › cart › keeps items",
    );
    expect(testTitle(externalTest(["cart", "keeps items"], { project: "chromium" }))).toBe(
      "[chromium] cart › keeps items",
    );
  });
});

describe("mapTests", () => {
  it("takes the bracketed id nearest the test's own name, then the enclosing suites", () => {
    const own = externalTest([
      "Cart [SHOP-CART-001]",
      "keeps items [SHOP-CART-002] [SHOP-CART-001]",
    ]);
    const suite = externalTest(["Cart [SHOP-CART-001]", "checkout", "keeps items"]);

    expect(byCase(mapTests(inputs([own, suite])))).toEqual([
      ["SHOP-CART-002", ["Cart [SHOP-CART-001] › keeps items [SHOP-CART-002] [SHOP-CART-001]"]],
      ["SHOP-CART-001", ["Cart [SHOP-CART-001] › checkout › keeps items"]],
    ]);
  });

  it("finds a bracketed id in a name that holds a long number elsewhere", () => {
    const tests = [externalTest(["order 123456789 keeps items [SHOP-CART-001]"])];

    expect(byCase(mapTests(inputs(tests)))).toEqual([
      ["SHOP-CART-001", ["order 123456789 keeps items [SHOP-CART-001]"]],
    ]);
  });

  it("reads a tag with or without @ when no name has a bracketed id, and skips other tags", () => {
    const tests = [
      externalTest(["keeps items"], { tags: ["smoke", "@SHOP-CART-001"] }),
      externalTest(["pays"], { tags: ["SHOP-CART-002"] }),
      externalTest(["keeps items [SHOP-CART-001]"], { tags: ["SHOP-CART-002"] }),
    ];

    expect(byCase(mapTests(inputs(tests)))).toEqual([
      ["SHOP-CART-001", ["keeps items", "keeps items [SHOP-CART-001]"]],
      ["SHOP-CART-002", ["pays"]],
    ]);
  });

  it("falls back to the mapping file, keyed by the title without the project", () => {
    const tagged = externalTest(["com.shop.CartTest", "keepsItems"], { tags: ["@SHOP-CART-001"] });
    const mapped = externalTest(["com.shop.CartTest", "keepsItems"], { project: "chromium" });
    const mapping = { tests: { "com.shop.CartTest › keepsItems": "SHOP-CART-002" } };

    expect(byCase(mapTests(inputs([tagged, mapped], { mapping })))).toEqual([
      ["SHOP-CART-001", ["com.shop.CartTest › keepsItems"]],
      ["SHOP-CART-002", ["[chromium] com.shop.CartTest › keepsItems"]],
    ]);
  });

  it("lists each test it cannot place with the reason, under the full title", () => {
    const tests = [
      externalTest(["checkout", "pays"], { project: "chromium" }),
      // a title that names a property every object has must not read the mapping file's prototype
      externalTest(["constructor"]),
      externalTest(["pays [SHOP-CART-404]"]),
      externalTest(["pays"], { tags: ["@SHOP-PAY-001"] }),
    ];

    const mapped = mapTests(inputs(tests, { mapping: { tests: {} } }));

    expect(mapped.byCase.size).toBe(0);
    expect(mapped.unmapped).toEqual([
      {
        target: TARGET,
        title: "[chromium] checkout › pays",
        reason: "no case id in the test name, its tags or the mapping file",
      },
      {
        target: TARGET,
        title: "constructor",
        reason: "no case id in the test name, its tags or the mapping file",
      },
      { target: TARGET, title: "pays [SHOP-CART-404]", reason: "no case SHOP-CART-404" },
      {
        target: TARGET,
        title: "pays",
        reason: "case SHOP-PAY-001 does not run on target shop-chrome",
      },
    ]);
  });

  it("keeps the tests of selected cases in report order and counts the others", () => {
    const tests = [
      externalTest(["second [SHOP-CART-002]"]),
      externalTest(["first [SHOP-CART-001]"]),
      externalTest(["second again [SHOP-CART-002]"]),
    ];

    const all = mapTests(inputs(tests));
    const narrowed = mapTests(inputs(tests, { selected: new Set(["SHOP-CART-002"]) }));

    expect(byCase(all)).toEqual([
      ["SHOP-CART-002", ["second [SHOP-CART-002]", "second again [SHOP-CART-002]"]],
      ["SHOP-CART-001", ["first [SHOP-CART-001]"]],
    ]);
    expect([all.outsideSelection, narrowed.outsideSelection, narrowed.unmapped]).toEqual([
      0,
      1,
      [],
    ]);
    expect(byCase(narrowed)).toEqual([
      ["SHOP-CART-002", ["second [SHOP-CART-002]", "second again [SHOP-CART-002]"]],
    ]);
  });
});
