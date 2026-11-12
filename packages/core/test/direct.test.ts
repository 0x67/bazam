import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { BRAND } from "../src/brand.ts";
import { PLUGIN_API_VERSION, PluginRegistry, type PluginManifest } from "../src/plugin/index.ts";
import { ProjectConfig } from "../src/project.ts";
import { defaultRedactionRules, Redactor } from "../src/redact/index.ts";
import {
  describeDirectPost,
  loadReceipts,
  postPlanDirect,
  type ItemOutcome,
  type PostPlan,
  type PostPlanItem,
  type RenderedComment,
  type TrackerClient,
  TrackerRequestFailed,
} from "../src/report/index.ts";
import {
  fakeTrackerClient,
  FakeTrackerConnection,
  type FakeTrackerCall,
} from "./support/fake-tracker.ts";

const RUN = "20261108-100000-ab12";
const NOW = new Date("2026-11-08T10:05:00Z");
const TOKEN = "fake-token-4821";

const CONFIG = ProjectConfig.parse({
  envs: {},
  trackers: {
    jira: {
      site: "tracker.example.test",
      projects: { DEMO: { transitions: { fail: "In Progress" } } },
    },
    linear: { projects: { ENG: {} } },
  },
});

// an item with a file to attach and a transition
const FULL = { attachments: ["CHECKOUT-CART-001/01-cart.png"], transition: "In Progress" };

function item(fields: Partial<PostPlanItem> = {}): PostPlanItem {
  const caseId = fields.caseId ?? "CHECKOUT-CART-001";
  return {
    marker: `${BRAND.markerPrefix}:${caseId}:${RUN}`,
    ticket: { tracker: "jira", key: "DEMO-12" },
    caseId,
    status: "fail",
    comment: { markdown: "**FAIL** the cart total is wrong" },
    attachments: [],
    mentions: [],
    unresolved: [],
    ...fields,
  };
}

function plan(items: PostPlanItem[]): PostPlan {
  return { runId: RUN, env: "uat", createdAt: NOW.toISOString(), items };
}

function callsFor(connection: FakeTrackerConnection, key: string): FakeTrackerCall["method"][] {
  return connection.calls
    .filter((call) => "key" in call && call.key === key)
    .map((call) => call.method);
}

describe("postPlanDirect", () => {
  let root: string;
  let runDir: string;
  let stateDir: string;
  let redactor: Redactor;
  let connection: FakeTrackerConnection;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "direct-test-"));
    runDir = join(root, "runs", RUN);
    stateDir = join(root, BRAND.stateDir);
    redactor = new Redactor(defaultRedactionRules());
    connection = new FakeTrackerConnection([
      { key: "DEMO-12", status: "To Do", assignee: "acc-assignee-1", reporter: "acc-reporter-2" },
      { key: "DEMO-14", status: "To Do", reporter: "acc-reporter-2" },
    ]);
  });

  async function post(items: PostPlanItem[], clients: TrackerClient[]): Promise<ItemOutcome[]> {
    const manifest: PluginManifest = {
      name: "fake-tracker",
      apiVersion: PLUGIN_API_VERSION,
      trackerClients: clients,
    };
    const registry = await PluginRegistry.load(CONFIG, root, [manifest]);
    return postPlanDirect(plan(items), {
      runDir,
      stateDir,
      config: CONFIG,
      registry,
      secret: async (name) => `secret-${name}`,
      redactor,
      signal: new AbortController().signal,
      now: () => NOW,
      log: () => {},
    });
  }

  it("reads the ticket, attaches, comments, records a receipt and moves it, in that order", async () => {
    const client = fakeTrackerClient(connection);
    const outcomes = await post([item(FULL)], [client]);

    expect(outcomes).toEqual([
      {
        marker: `${BRAND.markerPrefix}:CHECKOUT-CART-001:${RUN}`,
        ticket: { tracker: "jira", key: "DEMO-12" },
        ok: true,
        url: "https://tracker.example.test/browse/DEMO-12?focusedCommentId=10001",
        actions: ["attached 01-cart.png", "posted a comment", "moved to In Progress"],
        unresolved: [],
      },
    ]);
    expect(connection.methods()).toEqual(["ticket", "attach", "postComment", "transition"]);
    expect(connection.attachments.get("DEMO-12")).toEqual([
      { name: "01-cart.png", path: join(runDir, "CHECKOUT-CART-001", "01-cart.png") },
    ]);
    expect(connection.tickets.get("DEMO-12")?.status).toBe("In Progress");
    expect(client.contexts.map((ctx) => ctx.config)).toEqual([CONFIG.trackers["jira"]]);
    const receipts = await loadReceipts(stateDir);
    expect(receipts.latest("jira", "DEMO-12", "CHECKOUT-CART-001")).toEqual({
      marker: `${BRAND.markerPrefix}:CHECKOUT-CART-001:${RUN}`,
      url: "https://tracker.example.test/browse/DEMO-12?focusedCommentId=10001",
      postedAt: NOW.toISOString(),
    });
  });

  it("mentions the ticket's assignee and reporter and the plan's account ids, and lists roles with no id", async () => {
    const mentions = [
      { role: "assignee" },
      { role: "reporter" },
      { role: "qa-lead", accountId: "acc-qa-7" },
    ];
    const outcomes = await post(
      [item({ mentions }), item({ ticket: { tracker: "jira", key: "DEMO-14" }, mentions })],
      [fakeTrackerClient(connection)],
    );

    const posted = connection.calls.flatMap((call) =>
      call.method === "postComment" ? [call.mentions] : [],
    );
    expect(posted).toEqual([
      [
        { role: "assignee", accountId: "acc-assignee-1" },
        { role: "reporter", accountId: "acc-reporter-2" },
        { role: "qa-lead", accountId: "acc-qa-7" },
      ],
      [
        { role: "reporter", accountId: "acc-reporter-2" },
        { role: "qa-lead", accountId: "acc-qa-7" },
      ],
    ]);
    expect(outcomes.map((outcome) => [outcome.ok, outcome.unresolved])).toEqual([
      [true, []],
      [true, ["role:assignee"]],
    ]);
  });

  it("edits the comment a receipt names, and posts a new one when the client cannot edit the receipt's URL", async () => {
    const earlier = "https://tracker.example.test/browse/DEMO-12?focusedCommentId=10000";
    connection.comments.set("DEMO-12", [
      { url: earlier, comment: { markdown: "earlier run" }, mentions: [] },
    ]);
    const outcomes = await post(
      [
        item({ edit: { url: earlier } }),
        item({
          caseId: "CHECKOUT-CART-002",
          ticket: { tracker: "jira", key: "DEMO-14" },
          edit: { url: "https://tracker.example.test/browse/DEMO-14" },
        }),
      ],
      [fakeTrackerClient(connection)],
    );

    expect(outcomes.map(({ ok, url, actions }) => ({ ok, url, actions }))).toEqual([
      { ok: true, url: earlier, actions: ["edited the comment"] },
      {
        ok: true,
        url: "https://tracker.example.test/browse/DEMO-14?focusedCommentId=10001",
        actions: ["posted a new comment: the receipt URL names no comment to edit"],
      },
    ]);
    expect(connection.comments.get("DEMO-12")).toEqual([
      { url: earlier, comment: { markdown: "**FAIL** the cart total is wrong" }, mentions: [] },
    ]);
    expect(callsFor(connection, "DEMO-14")).toEqual(["ticket", "editComment", "postComment"]);
    const receipts = await loadReceipts(stateDir);
    expect(receipts.latest("jira", "DEMO-14", "CHECKOUT-CART-002")?.url).toBe(
      "https://tracker.example.test/browse/DEMO-14?focusedCommentId=10001",
    );
  });

  it("keeps a failed item's error, writes nothing for it and still posts the next item", async () => {
    const client = fakeTrackerClient(connection);
    const outcomes = await post(
      [item({ ...FULL, ticket: { tracker: "jira", key: "DEMO-404" } }), item(FULL)],
      [client],
    );

    expect(outcomes.map(({ ok, actions, error }) => ({ ok, actions, error }))).toEqual([
      { ok: false, actions: [], error: "DEMO-404 does not exist" },
      {
        ok: true,
        actions: ["attached 01-cart.png", "posted a comment", "moved to In Progress"],
        error: undefined,
      },
    ]);
    expect(callsFor(connection, "DEMO-404")).toEqual(["ticket"]);
    expect(client.contexts).toHaveLength(1);
  });

  it("fails only the transition when the ticket does not offer it, keeping the comment and its receipt", async () => {
    connection.tickets.set("DEMO-12", { key: "DEMO-12", status: "To Do", transitions: ["Done"] });
    const [outcome] = await post([item(FULL)], [fakeTrackerClient(connection)]);

    expect(outcome).toMatchObject({
      ok: false,
      url: "https://tracker.example.test/browse/DEMO-12?focusedCommentId=10001",
      actions: ["attached 01-cart.png", "posted a comment"],
      error: "transition In Progress is not available on DEMO-12; it offers Done",
    });
    expect(connection.comments.get("DEMO-12")).toHaveLength(1);
    expect(
      (await loadReceipts(stateDir)).latest("jira", "DEMO-12", "CHECKOUT-CART-001"),
    ).toBeDefined();
  });

  it("skips the transition when the ticket is already in that status, ignoring case", async () => {
    connection.tickets.set("DEMO-12", {
      key: "DEMO-12",
      status: "Ready for Release",
      transitions: ["Reopen"],
    });
    const [outcome] = await post(
      [item({ transition: "ready for release" })],
      [fakeTrackerClient(connection)],
    );

    expect(outcome).toMatchObject({
      ok: true,
      actions: ["posted a comment", "already in Ready for Release"],
    });
    expect(connection.methods()).toEqual(["ticket", "postComment"]);
    expect(
      (await loadReceipts(stateDir)).latest("jira", "DEMO-12", "CHECKOUT-CART-001"),
    ).toBeDefined();
  });

  it("refuses an issue that moved to a project the config does not list, sending nothing past the read", async () => {
    connection.tickets.set("DEMO-12", { key: "SEC-3", status: "To Do" });
    const [outcome] = await post([item(FULL)], [fakeTrackerClient(connection)]);

    expect(outcome).toMatchObject({
      ok: false,
      actions: [],
      error:
        "DEMO-12 is now SEC-3, in project SEC, which is not listed under trackers.jira.projects",
    });
    expect(connection.methods()).toEqual(["ticket"]);
    expect(
      (await loadReceipts(stateDir)).latest("jira", "DEMO-12", "CHECKOUT-CART-001"),
    ).toBeUndefined();
  });

  it("fails an item with an attachment outside the run folder before it reads the ticket", async () => {
    const client = fakeTrackerClient(connection);
    const outside = "CHECKOUT-CART-001/../../../outside.txt";
    const [outcome] = await post(
      [item({ attachments: ["CHECKOUT-CART-001/01-cart.png", outside] })],
      [client],
    );

    expect(outcome).toMatchObject({
      ok: false,
      actions: [],
      error: `attachment ${outside} is outside the run folder`,
    });
    expect(client.contexts).toEqual([]);
    expect(connection.calls).toEqual([]);
  });

  describe("inline media", () => {
    const earlier = "https://tracker.example.test/browse/DEMO-12?focusedCommentId=10000";
    const media = new Map([["01-cart.png", { id: "media-1", width: 4, height: 3 }]]);
    const inline = (comment: RenderedComment): RenderedComment => ({
      ...comment,
      markdown: `${comment.markdown} [inline]`,
    });

    beforeEach(() => {
      connection.uploaded = media;
      connection.showUploads = inline;
    });

    it("posts the comment with the uploads shown", async () => {
      await post([item(FULL)], [fakeTrackerClient(connection)]);

      expect(connection.comments.get("DEMO-12")?.[0]?.comment.markdown).toBe(
        "**FAIL** the cart total is wrong [inline]",
      );
    });

    it("edits the comment with the uploads shown", async () => {
      connection.comments.set("DEMO-12", [
        { url: earlier, comment: { markdown: "earlier run" }, mentions: [] },
      ]);
      await post([item({ ...FULL, edit: { url: earlier } })], [fakeTrackerClient(connection)]);

      expect(connection.comments.get("DEMO-12")?.[0]?.comment.markdown).toBe(
        "**FAIL** the cart total is wrong [inline]",
      );
    });

    it("posts the plan's comment when the connection cannot show uploads", async () => {
      delete connection.showUploads;
      await post([item(FULL)], [fakeTrackerClient(connection)]);

      expect(connection.comments.get("DEMO-12")?.[0]?.comment.markdown).toBe(
        "**FAIL** the cart total is wrong",
      );
    });

    it("posts the plan's comment when the tracker answers 400 to the one with media", async () => {
      connection.refuses = (comment) =>
        comment.markdown.endsWith("[inline]")
          ? new TrackerRequestFailed("POST /comment answered 400", 400)
          : undefined;
      const [outcome] = await post([item(FULL)], [fakeTrackerClient(connection)]);

      expect(outcome).toMatchObject({
        ok: true,
        actions: ["attached 01-cart.png", "posted a comment", "moved to In Progress"],
      });
      expect(connection.comments.get("DEMO-12")?.map((entry) => entry.comment.markdown)).toEqual([
        "**FAIL** the cart total is wrong",
      ]);
    });

    it("fails the item as before on any other error", async () => {
      connection.refuses = () => new TrackerRequestFailed("POST /comment answered 500", 500);
      const [outcome] = await post([item(FULL)], [fakeTrackerClient(connection)]);

      expect(outcome).toMatchObject({ ok: false, error: "POST /comment answered 500" });
      expect(connection.comments.get("DEMO-12")).toBeUndefined();
    });
  });

  it("refuses an item whose project is not listed, or whose tracker has no site, and sends nothing for it", async () => {
    const client = fakeTrackerClient(connection);
    const outcomes = await post(
      [
        item({ ticket: { tracker: "jira", key: "OPS-3" } }),
        item({ ticket: { tracker: "linear", key: "ENG-1" } }),
        item({ ticket: { tracker: "github", key: "WEB-5" } }),
      ],
      [client],
    );

    expect(outcomes.map(({ ok, error }) => ({ ok, error }))).toEqual([
      { ok: false, error: "project OPS is not listed under trackers.jira.projects" },
      { ok: false, error: "trackers.linear.site is not set" },
      { ok: false, error: "trackers.github.site is not set" },
    ]);
    expect(client.contexts).toEqual([]);
    expect(connection.calls).toEqual([]);
  });

  it("fails every item of a tracker whose connect fails, with the error masked", async () => {
    redactor.register(TOKEN);
    const client = fakeTrackerClient(connection, {
      connectError: new Error(`the tracker refused ${TOKEN}`),
    });
    const outcomes = await post(
      [item(), item({ ticket: { tracker: "jira", key: "DEMO-14" } })],
      [client],
    );

    expect(outcomes.map(({ ok, error }) => ({ ok, error }))).toEqual([
      { ok: false, error: "the tracker refused [redacted]" },
      { ok: false, error: "the tracker refused [redacted]" },
    ]);
    expect(client.contexts).toHaveLength(1);
    expect(connection.calls).toEqual([]);
  });

  it("fails the items of a tracker that no plugin has a client for", async () => {
    const outcomes = await post([item()], []);

    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: 'unknown tracker client "jira"; known: none',
    });
  });
});

describe("describeDirectPost", () => {
  it("lists each action an item would take, and the error of an item the guard refuses", () => {
    const lines = describeDirectPost(
      plan([
        item({
          ...FULL,
          mentions: [{ role: "assignee" }, { role: "qa-lead", accountId: "acc-qa-7" }],
        }),
        item({
          caseId: "CHECKOUT-CART-002",
          status: "pass",
          ticket: { tracker: "jira", key: "DEMO-14" },
          edit: { url: "https://tracker.example.test/browse/DEMO-14?focusedCommentId=10007" },
        }),
        item({ ticket: { tracker: "jira", key: "OPS-3" } }),
      ]),
      CONFIG,
    );

    expect(lines).toEqual([
      "jira:DEMO-12 read the ticket",
      "jira:DEMO-12 attach 01-cart.png",
      "jira:DEMO-12 post the fail comment for CHECKOUT-CART-001, mentioning assignee, qa-lead",
      "jira:DEMO-12 move to In Progress",
      "jira:DEMO-14 read the ticket",
      "jira:DEMO-14 edit the pass comment for CHECKOUT-CART-002 at https://tracker.example.test/browse/DEMO-14?focusedCommentId=10007",
      "jira:OPS-3 fails: project OPS is not listed under trackers.jira.projects",
    ]);
  });
});
