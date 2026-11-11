import { describe, expect, it } from "vite-plus/test";
import { CaseSpec } from "../src/case/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { ticketsReadyForPromotion, type TicketState } from "../src/report/index.ts";

const CONFIG = ProjectConfig.parse({
  envs: {},
  trackers: {
    jira: {
      site: "tracker.example.test",
      projects: {
        DEMO: { promoteOn: ["Done", "Released"] },
        SHOP: { promoteOn: ["Shipped"] },
        OPS: {},
      },
    },
  },
});

function spec(links: string[]): CaseSpec {
  return CaseSpec.parse({
    id: "CHECKOUT-CART-001",
    title: "Cart total includes the discount",
    stage: "acceptance",
    risk: "high",
    links,
    targets: ["web"],
  });
}

function states(entries: Record<string, string>): Map<string, TicketState> {
  return new Map(
    Object.entries(entries).map(([link, status]) => [
      link,
      { key: link.split(":")[1]!, status, done: false },
    ]),
  );
}

describe("ticketsReadyForPromotion", () => {
  it("is ready when every linked ticket is in its project's promoteOn, compared without case", () => {
    const verdict = ticketsReadyForPromotion(
      spec(["jira:DEMO-12", "jira:DEMO-14", "jira:SHOP-3"]),
      states({ "jira:DEMO-12": "done", "jira:DEMO-14": "RELEASED", "jira:SHOP-3": "Shipped" }),
      CONFIG,
    );

    expect(verdict).toEqual({ ready: true });
  });

  it("names the first linked ticket that is not ready", () => {
    const verdict = ticketsReadyForPromotion(
      spec(["jira:DEMO-12", "jira:DEMO-14", "jira:SHOP-3"]),
      states({ "jira:DEMO-12": "Done", "jira:DEMO-14": "In Review", "jira:SHOP-3": "To Do" }),
      CONFIG,
    );

    expect(verdict).toEqual({
      ready: false,
      reason: "DEMO-14 is In Review; promoteOn lists Done, Released",
    });
  });

  it("says when the project's promoteOn lists no status", () => {
    const verdict = ticketsReadyForPromotion(
      spec(["jira:OPS-7"]),
      states({ "jira:OPS-7": "Done" }),
      CONFIG,
    );

    expect(verdict).toEqual({
      ready: false,
      reason: "OPS-7 is Done; trackers.jira.projects.OPS.promoteOn lists no status",
    });
  });

  it("keeps a case with no linked tickets", () => {
    expect(ticketsReadyForPromotion(spec([]), new Map(), CONFIG)).toEqual({
      ready: false,
      reason: "no linked tickets",
    });
  });

  it("keeps a case linked to a project the config does not list, whatever its state", () => {
    const verdict = ticketsReadyForPromotion(
      spec(["jira:DEMO-12", "jira:WEB-5"]),
      states({ "jira:DEMO-12": "Done", "jira:WEB-5": "Done" }),
      CONFIG,
    );

    expect(verdict).toEqual({
      ready: false,
      reason: "project WEB is not listed under trackers.jira.projects",
    });
  });

  it("keeps a case whose linked ticket was not read", () => {
    const verdict = ticketsReadyForPromotion(spec(["jira:DEMO-12"]), new Map(), CONFIG);

    expect(verdict).toEqual({ ready: false, reason: "DEMO-12 was not read" });
  });
});
