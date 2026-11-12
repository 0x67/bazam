import { z } from "zod";
import type { ChallengeResolver, ResolverContext } from "../challenge/index.ts";
import type {
  CaseEnding,
  Driver,
  DriverSession,
  LaunchOptions,
  StepContext,
  StepHandler,
} from "../driver/index.ts";
import type { Environment } from "../env/index.ts";
import type { TrackerClient, TrackerClientContext, TrackerConnection } from "../report/index.ts";
import type { ContributionsDescriptor, METHODS } from "./protocol.ts";
import type { PluginManifest } from "./registry.ts";

type Methods = typeof METHODS;

/** Sends one request to the plugin and returns its parsed result; `process.ts` adds the timeout and maps errors. */
export type PluginCall = <M extends keyof Methods>(
  method: M,
  params: z.input<Methods[M]["params"]>,
  signal?: AbortSignal,
) => Promise<z.output<Methods[M]["result"]>>;

/** An in-process context that the plugin's `host.*` callbacks reach by `contextId` while its call runs. */
export type HostContext =
  | ResolverContext
  | StepContext
  | LaunchOptions
  | TrackerClientContext
  | CaseEnding;

export interface HostCalls {
  /** Returns a fresh `contextId` for `context`. */
  register(context: HostContext): string;
  release(contextId: string): void;
}

type Within = <T>(context: HostContext, run: (contextId: string) => Promise<T>) => Promise<T>;

const OFFERED: ReadonlySet<string> = new Set([
  "resolvers",
  "challengeKinds",
  "secretProviders",
  "resultFormats",
  "trackerClients",
  "drivers",
]);

/**
 * Contributions that look in-process and call the plugin. Each call registers its context for the length of the
 * call. Throws on a type a process plugin cannot offer, and on a step schema that `z.fromJSONSchema` cannot read.
 */
export function proxyContributions(
  call: PluginCall,
  plugin: string,
  descriptor: ContributionsDescriptor,
  calls: HostCalls,
): Omit<PluginManifest, "name" | "apiVersion"> {
  for (const key of Object.keys(descriptor)) {
    if (!OFFERED.has(key)) {
      throw new Error(
        `plugin ${plugin} offers ${key}, which a process plugin cannot offer; load it in-process`,
      );
    }
  }
  const within: Within = async (context, run) => {
    const contextId = calls.register(context);
    try {
      return await run(contextId);
    } finally {
      calls.release(contextId);
    }
  };
  return {
    resolvers: (descriptor.resolvers ?? []).map((spec) => resolverProxy(call, within, spec)),
    challengeKinds: descriptor.challengeKinds ?? [],
    secretProviders: (descriptor.secretProviders ?? []).map(({ name }) => ({
      name,
      load: async (key) => (await call("secrets.load", { provider: name, key })) ?? undefined,
    })),
    resultFormats: (descriptor.resultFormats ?? []).map(({ name }) => ({
      name,
      parse: (file) => call("results.parse", { format: name, file }),
    })),
    trackerClients: (descriptor.trackerClients ?? []).map(({ tracker }) =>
      trackerClientProxy(call, within, tracker),
    ),
    drivers: (descriptor.drivers ?? []).map((spec) => driverProxy(call, within, plugin, spec)),
  };
}

function resolverProxy(
  call: PluginCall,
  within: Within,
  spec: NonNullable<ContributionsDescriptor["resolvers"]>[number],
): ChallengeResolver {
  const { name: resolver } = spec;
  const proxy: ChallengeResolver = {
    name: resolver,
    kinds: spec.kinds,
    requires: spec.requires,
    automated: spec.automated,
    async resolve(request, ctx, kind) {
      const answer = await within(ctx, (contextId) =>
        call(
          "resolver.resolve",
          { resolver, request, kind, context: resolverCallContext(contextId, ctx) },
          ctx.signal,
        ),
      );
      return answer ?? undefined;
    },
  };
  if (spec.arm) {
    proxy.arm = async (request, ctx) => {
      await within(ctx, (contextId) =>
        call(
          "resolver.arm",
          { resolver, request, context: resolverCallContext(contextId, ctx) },
          ctx.signal,
        ),
      );
    };
  }
  return proxy;
}

function trackerClientProxy(call: PluginCall, within: Within, tracker: string): TrackerClient {
  return {
    tracker,
    async connect(ctx) {
      const { connection } = await within(ctx, (contextId) =>
        call("trackerClient.connect", { tracker, contextId, config: ctx.config }, ctx.signal),
      );
      // each call on the connection registers connect's context again, under a fresh contextId
      const on = <T>(
        run: (ids: { tracker: string; connection: string; contextId: string }) => Promise<T>,
      ) => within(ctx, (contextId) => run({ tracker, connection, contextId }));
      const proxy: TrackerConnection = {
        ticket: (key) => on((ids) => call("trackerClient.ticket", { ...ids, key }, ctx.signal)),
        async attach(key, files) {
          await on((ids) =>
            call("trackerClient.attach", { ...ids, key, files: [...files] }, ctx.signal),
          );
          return new Map();
        },
        postComment: (key, comment, mentions) =>
          on((ids) =>
            call(
              "trackerClient.postComment",
              { ...ids, key, comment, mentions: [...mentions] },
              ctx.signal,
            ),
          ),
        async editComment(key, url, comment, mentions) {
          const edited = await on((ids) =>
            call(
              "trackerClient.editComment",
              { ...ids, key, url, comment, mentions: [...mentions] },
              ctx.signal,
            ),
          );
          return edited ?? undefined;
        },
        async transition(key, name) {
          await on((ids) => call("trackerClient.transition", { ...ids, key, name }, ctx.signal));
        },
        async findOpenBug(project, label) {
          return (
            (await on((ids) =>
              call("trackerClient.findOpenBug", { ...ids, project, label }, ctx.signal),
            )) ?? undefined
          );
        },
        createBug: (draft) =>
          on((ids) => call("trackerClient.createBug", { ...ids, draft }, ctx.signal)),
      };
      return proxy;
    },
  };
}

function driverProxy(
  call: PluginCall,
  within: Within,
  plugin: string,
  spec: NonNullable<ContributionsDescriptor["drivers"]>[number],
): Driver {
  const { name: driver } = spec;
  // the plugin's id for each session this proxy launched
  const sessions = new WeakMap<DriverSession, string>();
  const steps = spec.steps.map(({ kind, schema }): StepHandler => ({
    kind,
    schema: stepSchema(plugin, kind, schema),
    async run(step, ctx) {
      const session = sessions.get(ctx.session);
      if (session === undefined)
        throw new Error(`step ${kind} runs in a session that driver ${driver} did not launch`);
      await within(ctx, (contextId) =>
        call(
          "driver.step",
          // the case loader parsed the payload from YAML, so it is JSON
          {
            session,
            kind,
            step: step as z.core.util.JSONType,
            context: stepCallContext(contextId, ctx),
          },
          ctx.signal,
        ),
      );
    },
  }));
  return {
    name: driver,
    surface: spec.surface,
    async probe(options) {
      const capabilities = await within(options, (contextId) =>
        call("driver.probe", { driver, options: launchCallOptions(contextId, options) }),
      );
      return new Set(capabilities);
    },
    async launch(options) {
      const launched = await within(options, (contextId) =>
        call("driver.launch", { driver, options: launchCallOptions(contextId, options) }),
      );
      const session: DriverSession = {
        capabilities: new Set(launched.capabilities),
        async close(ending) {
          await within(ending, (contextId) =>
            call("driver.close", {
              session: launched.session,
              ending: { status: ending.status },
              context: { contextId },
            }),
          );
        },
      };
      sessions.set(session, launched.session);
      return session;
    },
    steps,
  };
}

function stepSchema(plugin: string, kind: string, schema: z.core.JSONSchema.JSONSchema): z.ZodType {
  try {
    return z.fromJSONSchema(schema);
  } catch (error) {
    throw new Error(
      `plugin ${plugin} gives step ${kind} a schema that cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// an Environment with its host set as a list
function wireEnv(env: Environment) {
  return {
    name: env.name,
    production: env.production,
    vars: { ...env.vars },
    hosts: [...env.hosts],
    challenges: Object.fromEntries(
      Object.entries(env.challenges).map(([kind, chain]) => [kind, [...chain]]),
    ),
    locale: env.locale,
  };
}

function resolverCallContext(contextId: string, ctx: ResolverContext) {
  return {
    contextId,
    env: wireEnv(ctx.env),
    prompt: { runId: ctx.prompt.runId, timeoutMs: ctx.prompt.timeoutMs },
    stateDir: ctx.stateDir,
  };
}

function stepCallContext(contextId: string, ctx: StepContext) {
  return {
    contextId,
    ...(ctx.identity === undefined ? {} : { identity: ctx.identity }),
    env: wireEnv(ctx.env),
    values: Object.fromEntries(ctx.values),
  };
}

function launchCallOptions(contextId: string, options: LaunchOptions) {
  return {
    contextId,
    env: wireEnv(options.env),
    target: options.target,
    settings: options.settings,
    runDir: options.runDir,
    redaction: { screenshotSelectors: [...options.redactor.selectors()] },
  };
}
