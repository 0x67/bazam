import { z } from "zod";
import type { JsonValue } from "../auth/index.ts";
import type { ChallengeAnswer, ChallengeKindSpec, ChallengeRequest } from "../challenge/index.ts";
import type { ExternalTest, ResultFile } from "../ingest/index.ts";
import { TrackerConfig } from "../project.ts";
import type {
  AttachmentFile,
  BugDraft,
  Mention,
  PostedComment,
  RenderedComment,
  TicketState,
} from "../report/index.ts";
import type { CheckRecord, Status } from "../result/index.ts";

/** The version of the wire protocol below, which `initialize` checks; the plugin API version is separate. */
export const PROTOCOL_VERSION = 1;

/** What a process plugin offers, as its `initialize` answer lists it. */
export interface ContributionsDescriptor {
  resolvers?: { name: string; kinds: string[]; requires: string[]; automated: boolean; arm: boolean }[];
  challengeKinds?: ChallengeKindSpec[];
  secretProviders?: { name: string }[];
  resultFormats?: { name: string }[];
  trackerClients?: { tracker: string }[];
  drivers?: { name: string; surface: string; steps: { kind: string; schema: z.core.JSONSchema.JSONSchema }[] }[];
}

const Name = z.string().min(1);
const ContextId = z.string().min(1);
const JsonSchema = z.custom<z.core.JSONSchema.JSONSchema>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  { error: "a step schema is a JSON Schema object" },
);

const ChallengeKindSpecSchema = z.object({
  name: Name,
  answer: z.enum(["value", "action"]),
  humanOnly: z.boolean(),
  fallbackAfterTrigger: z.boolean(),
}) satisfies z.ZodType<ChallengeKindSpec>;

// unknown keys stay, so the loader can name a contribution type a process plugin cannot offer
const Contributions = z.looseObject({
  resolvers: z
    .array(
      z.object({
        name: Name,
        kinds: z.array(Name),
        requires: z.array(Name),
        automated: z.boolean(),
        arm: z.boolean(),
      }),
    )
    .exactOptional(),
  challengeKinds: z.array(ChallengeKindSpecSchema).exactOptional(),
  secretProviders: z.array(z.object({ name: Name })).exactOptional(),
  resultFormats: z.array(z.object({ name: Name })).exactOptional(),
  trackerClients: z.array(z.object({ tracker: Name })).exactOptional(),
  drivers: z
    .array(
      z.object({
        name: Name,
        surface: Name,
        steps: z.array(z.object({ kind: Name, schema: JsonSchema })),
      }),
    )
    .exactOptional(),
}) satisfies z.ZodType<ContributionsDescriptor>;

// an Environment with `hosts` as a list, since a Set does not cross as JSON
const WireEnv = z.object({
  name: Name,
  production: z.boolean(),
  vars: z.record(z.string(), z.string()),
  hosts: z.array(Name),
  challenges: z.record(z.string(), z.array(Name)),
  locale: Name,
});

const ResolverCallContext = z.object({
  contextId: ContextId,
  env: WireEnv,
  prompt: z.object({ runId: Name, timeoutMs: z.number().positive() }),
  stateDir: Name,
});

const StepCallContext = z.object({
  contextId: ContextId,
  identity: Name.exactOptional(),
  env: WireEnv,
  // a Map in process
  values: z.record(z.string(), z.string()),
});

// contextId ties the call to its context
const LaunchCallOptions = z.object({
  contextId: ContextId,
  env: WireEnv,
  target: Name,
  settings: z.record(z.string(), z.json()) satisfies z.ZodType<Record<string, JsonValue>>,
  runDir: Name,
  redaction: z.object({ screenshotSelectors: z.array(Name) }),
});

const ChallengeRequestSchema = z.object({
  kind: Name,
  caseId: Name,
  identity: z.string(),
  step: z.int().nonnegative(),
  params: z.record(z.string(), z.string()),
}) satisfies z.ZodType<ChallengeRequest>;

const ChallengeAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.string() }),
  z.object({ kind: z.literal("done") }),
]) satisfies z.ZodType<ChallengeAnswer>;

const ResolverCall = z.object({
  resolver: Name,
  request: ChallengeRequestSchema,
  kind: ChallengeKindSpecSchema.exactOptional(),
  context: ResolverCallContext,
});

const ResultFileSchema = z.object({ path: Name, text: z.string() }) satisfies z.ZodType<ResultFile>;

const ExternalTestSchema = z.object({
  title: z.array(z.string()),
  tags: z.array(z.string()),
  outcome: z.enum(["passed", "failed", "errored", "skipped"]),
  message: z.string().exactOptional(),
  retries: z.int().nonnegative(),
  project: z.string().exactOptional(),
  durationMs: z.number().nonnegative().exactOptional(),
  attachments: z.array(z.object({ name: z.string(), path: Name, contentType: z.string().exactOptional() })),
  source: Name,
}) satisfies z.ZodType<ExternalTest>;

const RenderedCommentSchema = z.object({
  markdown: z.string(),
  html: z.string().exactOptional(),
  adf: z.json().exactOptional(),
}) satisfies z.ZodType<RenderedComment>;

const MentionSchema = z.object({ role: Name, accountId: Name }) satisfies z.ZodType<Mention>;
const AttachmentFileSchema = z.object({ name: Name, path: Name }) satisfies z.ZodType<AttachmentFile>;
const PostedCommentSchema = z.object({ url: Name }) satisfies z.ZodType<PostedComment>;

const TicketStateSchema = z.object({
  key: Name,
  status: z.string(),
  done: z.boolean(),
  assignee: z.string().exactOptional(),
  reporter: z.string().exactOptional(),
}) satisfies z.ZodType<TicketState>;

const BugDraftSchema = z.object({
  project: Name,
  issueType: Name,
  summary: z.string(),
  labels: z.array(Name),
  description: RenderedCommentSchema,
  attachments: z.array(AttachmentFileSchema),
  relatesTo: z.array(Name),
}) satisfies z.ZodType<BugDraft>;

const Connection = { tracker: Name, connection: Name, contextId: ContextId };

// JSON drops an undefined value, so a missing key reads as undefined
const AnyValue = z.unknown().default(undefined);

const CheckRecordSchema = z.object({
  name: z.string(),
  kind: z.enum(["ui", "api", "guided", "followup", "external"]),
  expected: AnyValue,
  observed: AnyValue,
  ok: z.boolean(),
  hint: z.string().exactOptional(),
}) satisfies z.ZodType<CheckRecord>;

const StatusSchema = z.enum(["pass", "fail", "blocked", "followup"]) satisfies z.ZodType<Status>;

const Base64 = z.base64();
const HeaderRecord = z.record(z.string(), z.string());

/**
 * Every method of the protocol with the schemas of its params and result, keyed by its wire name.
 * The peer in `rpc.ts` moves messages and knows none of these; the host and the plugin side parse with them.
 * A notification has no result, so its result schema is `z.never()`.
 */
export const METHODS = {
  initialize: {
    params: z.object({
      protocolVersion: z.int(),
      apiVersion: z.int(),
      host: z.object({ name: Name, version: z.string() }),
    }),
    result: z.object({ protocolVersion: z.int(), name: Name, apiVersion: z.int(), contributions: Contributions }),
  },
  shutdown: { params: z.object({}), result: z.null() },
  "resolver.arm": { params: ResolverCall, result: z.null() },
  "resolver.resolve": { params: ResolverCall, result: ChallengeAnswerSchema.nullable() },
  "secrets.load": { params: z.object({ provider: Name, key: Name }), result: z.string().nullable() },
  "results.parse": {
    params: z.object({ format: Name, file: ResultFileSchema }),
    result: z.array(ExternalTestSchema),
  },
  "trackerClient.connect": {
    params: z.object({ tracker: Name, contextId: ContextId, config: TrackerConfig }),
    result: z.object({ connection: Name }),
  },
  "trackerClient.ticket": { params: z.object({ ...Connection, key: Name }), result: TicketStateSchema },
  "trackerClient.attach": {
    params: z.object({ ...Connection, key: Name, files: z.array(AttachmentFileSchema) }),
    result: z.null(),
  },
  "trackerClient.postComment": {
    params: z.object({ ...Connection, key: Name, comment: RenderedCommentSchema, mentions: z.array(MentionSchema) }),
    result: PostedCommentSchema,
  },
  "trackerClient.editComment": {
    params: z.object({
      ...Connection,
      key: Name,
      url: Name,
      comment: RenderedCommentSchema,
      mentions: z.array(MentionSchema),
    }),
    result: PostedCommentSchema.nullable(),
  },
  "trackerClient.transition": { params: z.object({ ...Connection, key: Name, name: Name }), result: z.null() },
  "trackerClient.findOpenBug": {
    params: z.object({ ...Connection, project: Name, label: Name }),
    result: Name.nullable(),
  },
  "trackerClient.createBug": {
    params: z.object({ ...Connection, draft: BugDraftSchema }),
    result: z.object({ key: Name, url: Name }),
  },
  "driver.probe": { params: z.object({ driver: Name, options: LaunchCallOptions }), result: z.array(Name) },
  "driver.launch": {
    params: z.object({ driver: Name, options: LaunchCallOptions }),
    result: z.object({ session: Name, capabilities: z.array(Name) }),
  },
  "driver.step": {
    params: z.object({ session: Name, kind: Name, step: z.json(), context: StepCallContext }),
    result: z.null(),
  },
  "driver.close": {
    params: z.object({
      session: Name,
      ending: z.object({ status: StatusSchema }),
      context: z.object({ contextId: ContextId }),
    }),
    result: z.null(),
  },
  "host.resolve": { params: z.object({ contextId: ContextId, value: z.json() }), result: z.json() },
  "host.secret": { params: z.object({ contextId: ContextId, key: Name }), result: z.string() },
  "host.http": {
    params: z.object({
      contextId: ContextId,
      request: z.object({ method: Name, url: z.url(), headers: HeaderRecord, bodyBase64: Base64.exactOptional() }),
      as: z.object({ identity: Name, surface: Name }).exactOptional(),
      write: z.boolean().exactOptional(),
    }),
    // body is the parsed JSON for a JSON content type, otherwise the text, and null when empty
    result: z.object({ status: z.int(), headers: HeaderRecord, body: z.json() }),
  },
  "host.evidence.record": { params: z.object({ contextId: ContextId, check: CheckRecordSchema }), result: z.null() },
  "host.evidence.note": { params: z.object({ contextId: ContextId, text: z.string() }), result: z.null() },
  "host.evidence.followup": {
    params: z.object({ contextId: ContextId, item: z.string(), hint: z.string() }),
    result: z.null(),
  },
  "host.evidence.attach": {
    params: z.object({
      contextId: ContextId,
      label: z.string(),
      ext: z.enum(["png", "txt", "json"], {
        error: (issue) =>
          issue.input === "zip" ? "a process plugin cannot attach zip files, which core cannot scrub" : undefined,
      }),
      dataBase64: Base64,
    }),
    result: z.object({ name: Name }),
  },
  "host.values.set": {
    params: z.object({ contextId: ContextId, name: Name, value: z.string() }),
    result: z.null(),
  },
  "host.log": { params: z.object({ line: z.string() }), result: z.never() },
  "$/cancelRequest": { params: z.object({ id: z.union([z.int(), z.string()]) }), result: z.never() },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;
