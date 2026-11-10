// An in-process manifest served as a process plugin, as a TypeScript plugin author would write one.
import { z } from "zod";
import type { StepContext, StepHandler } from "../../../src/driver/index.ts";
import { definePlugin, PLUGIN_API_VERSION, serveProcessPlugin } from "../../../src/plugin/index.ts";

const TOKEN = "fake-served-token-4410";

// the context of the last keep step, which a later stale step uses after its call has ended
let kept: StepContext | undefined;

function step<S>(kind: string, schema: z.ZodType<S>, run: StepHandler<S>["run"]): StepHandler {
  return { kind, schema, run } as StepHandler;
}

const steps: StepHandler[] = [
  step("check", z.strictObject({ name: z.string(), value: z.string() }), async (payload, ctx) => {
    const { name, value } = await ctx.resolve(payload);
    ctx.evidence.record({ name, kind: "ui", expected: value, observed: value, ok: true });
  }),
  step("attach", z.strictObject({ ext: z.enum(["txt", "zip"]) }), async ({ ext }, ctx) => {
    await ctx.evidence.attach("served", new TextEncoder().encode("served notes"), ext);
  }),
  step("save", z.strictObject({ name: z.string(), value: z.string() }), async (payload, ctx) => {
    const { name, value } = await ctx.resolve(payload);
    ctx.values.set(name, value);
  }),
  step(
    "fetch",
    z.strictObject({ url: z.string(), method: z.enum(["GET", "POST"]), write: z.boolean().optional() }),
    async (payload, ctx) => {
      const { url, method } = await ctx.resolve(payload);
      const response = await ctx.http.send({ method, url: new URL(url), headers: new Headers(), signal: ctx.signal });
      ctx.evidence.record({ name: `${method} answered`, kind: "api", expected: 200, observed: response.status, ok: true });
    },
  ),
  step("upload", z.strictObject({ url: z.string(), bytes: z.int() }), async (payload, ctx) => {
    const { url, bytes } = await ctx.resolve(payload);
    const request = { method: "POST", url: new URL(url), headers: new Headers(), body: new Uint8Array(bytes) };
    await ctx.http.send({ ...request, signal: ctx.signal });
  }),
  step("redirect", z.strictObject({ url: z.string() }), async (payload, ctx) => {
    const { url } = await ctx.resolve(payload);
    const request = { method: "GET", url: new URL(url), headers: new Headers(), redirect: "manual" as const };
    const response = await ctx.http.send({ ...request, signal: ctx.signal });
    const observed = `${response.status} ${response.headers.get("location")}`;
    ctx.evidence.record({ name: "redirect", kind: "api", expected: "302 /target", observed, ok: true });
  }),
  step("cookies", z.strictObject({ url: z.string() }), async (payload, ctx) => {
    const { url } = await ctx.resolve(payload);
    const { headers } = await ctx.http.send({ method: "GET", url: new URL(url), headers: new Headers(), signal: ctx.signal });
    const observed = JSON.stringify([headers.get("set-cookie"), headers.getSetCookie()]);
    ctx.evidence.record({ name: "cookies", kind: "api", expected: "both cookies", observed, ok: true });
  }),
  step(
    "strict",
    z.strictObject({ count: z.int() }).refine((payload) => payload.count > 0, { error: "count must be above 0" }),
    async () => {},
  ),
  step("fail", z.strictObject({}), async () => {
    throw new Error("the served step failed on purpose");
  }),
  step("exit", z.strictObject({}), async () => {
    process.exit(5);
  }),
  step("fill", z.strictObject({ field: z.unknown(), value: z.string() }), async (payload, ctx) => {
    ctx.evidence.note(`filled ${(await ctx.resolve(payload)).value}`);
  }),
  step("keep", z.strictObject({}), async (_payload, ctx) => {
    kept = ctx;
  }),
  step("stale", z.strictObject({}), async (payload) => {
    await kept?.resolve(payload);
  }),
];

const manifest = definePlugin({
  name: "served",
  apiVersion: PLUGIN_API_VERSION,
  challengeKinds: [{ name: "served-code", answer: "value", humanOnly: false, fallbackAfterTrigger: false }],
  resolvers: [
    {
      name: "served-otp",
      kinds: ["served-code"],
      requires: [],
      automated: true,
      async resolve(request, ctx) {
        const token = await ctx.secrets("SERVED_TOKEN");
        const response = await ctx.http.send({
          method: "GET",
          url: new URL(request.params["url"] ?? ""),
          headers: new Headers({ authorization: `Bearer ${token}` }),
        });
        return { kind: "value", value: String((response.body as { code: string }).code) };
      },
    },
    {
      name: "served-crash",
      kinds: ["served-code"],
      requires: [],
      automated: true,
      async arm() {
        process.exit(4);
      },
      resolve: async () => undefined,
    },
  ],
  secretProviders: [{ name: "served-secrets", load: async (key) => (key === "SERVED_TOKEN" ? TOKEN : undefined) }],
  resultFormats: [
    {
      name: "served-lines",
      // each line is an outcome and a title, such as "passed Cart keeps items [SHOP-CART-001]"
      parse: async (file) =>
        file.text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [outcome, ...title] = line.split(" ");
            return {
              title: [title.join(" ")],
              tags: [],
              outcome: outcome === "failed" ? "failed" : "passed",
              retries: 0,
              attachments: [],
              source: file.path,
            };
          }),
    },
  ],
  trackerClients: [
    {
      tracker: "served",
      async connect(ctx) {
        const token = await ctx.secret(ctx.config.secrets["token"] ?? "");
        ctx.log(`connected with ${token}`);
        return {
          ticket: async (key) => ({ key, status: "Open", done: false }),
          attach: async () => {},
          postComment: async (key, comment) => ({ url: `https://tracker.example.test/${key}?chars=${comment.markdown.length}` }),
          editComment: async () => undefined,
          transition: async () => {},
          findOpenBug: async () => undefined,
          // each related key stands for a link the tracker refused
          createBug: async (draft) => ({
            key: "BUG-1",
            url: "https://tracker.example.test/BUG-1",
            ...(draft.relatesTo.length === 0
              ? {}
              : { problems: draft.relatesTo.map((key) => `could not link BUG-1 to ${key}`) }),
          }),
        };
      },
    },
  ],
  drivers: [
    {
      name: "served",
      surface: "web",
      probe: async () => new Set(["served.screen"]),
      launch: async () => ({
        capabilities: new Set(["served.screen"]),
        close: async (ending) => ending.evidence.note(`session closed ${ending.status}`),
      }),
      steps,
    },
  ],
});

await serveProcessPlugin(manifest);
