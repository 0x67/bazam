import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialCache, type CredentialKey } from "@bazam/core/auth";
import type { ChallengeRequest, ChallengeResolver, ResolverContext } from "@bazam/core/challenge";
import type { BrowserContext } from "playwright";
import { z } from "zod";
import { playwrightDriver, WebSession } from "./driver.ts";

const RESOLVER = "passkey-virtual";
// the virtual authenticator answers at once; this leaves the page time to fetch its WebAuthn options first
const USE_TIMEOUT_MS = 10_000;
const USE_POLL_MS = 100;

const Passkey = z.object({
  id: z.string().min(1),
  rpId: z.string().min(1),
  userHandle: z.string(),
  privateKey: z.string().min(1),
  publicKey: z.string().min(1),
  signCount: z.number().int().nonnegative(),
});
type Passkey = z.infer<typeof Passkey>;

// each passkey's signature counter when the resolver armed, so resolve can tell one was created or used
const armedCounters = new WeakMap<ChallengeRequest, ReadonlyMap<string, number>>();

/**
 * Answers a passkey challenge with Playwright's virtual authenticator in the identity's browser context, and keeps
 * the identity's passkeys in the credential cache so a later run signs in with the one an earlier run registered.
 */
export const virtualPasskeyResolver: ChallengeResolver = {
  name: RESOLVER,
  kinds: ["passkey"],
  requires: ["webauthn.virtual"],
  automated: true,
  async arm(request, ctx) {
    const { context, session } = await identityContext(request, ctx);
    const stored = await loadPasskeys(request, ctx);
    const held = new Set((await context.credentials.get()).map((passkey) => passkey.id));
    await context.credentials.install();
    for (const passkey of stored) {
      session.redactor.register(passkey.privateKey);
      if (held.has(passkey.id)) continue;
      const { rpId, ...credential } = passkey;
      await context.credentials.create(rpId, credential);
    }
    armedCounters.set(request, new Map((await context.credentials.get()).map((passkey) => [passkey.id, passkey.signCount])));
  },
  async resolve(request, ctx) {
    const armed = armedCounters.get(request);
    if (armed === undefined) throw new Error(`${RESOLVER} answers only a challenge it armed before the trigger`);
    const { context, session } = await identityContext(request, ctx);
    const passkeys = await waitForUse(context, armed, ctx.signal);
    if (passkeys === undefined) return undefined;
    for (const passkey of passkeys) session.redactor.register(passkey.privateKey);
    await cache(ctx).save(cacheKey(request, ctx), passkeys);
    return { kind: "done" };
  },
};

async function identityContext(request: ChallengeRequest, ctx: ResolverContext): Promise<{ context: BrowserContext; session: WebSession }> {
  const session = ctx.session;
  if (!(session instanceof WebSession)) throw new Error(`${RESOLVER} needs a session of the ${playwrightDriver.name} driver`);
  return { context: (await session.contextFor(request.identity)).context, session };
}

/** The passkeys once one was registered or signed with since the resolver armed, or undefined when none was in time. */
async function waitForUse(context: BrowserContext, armed: ReadonlyMap<string, number>, signal: AbortSignal): Promise<Passkey[] | undefined> {
  const deadline = Date.now() + USE_TIMEOUT_MS;
  for (;;) {
    const passkeys = await context.credentials.get();
    // a new passkey starts at 0, and each sign-in adds one
    if (passkeys.some((passkey) => passkey.signCount > (armed.get(passkey.id) ?? -1))) return passkeys;
    if (Date.now() >= deadline) return undefined;
    await sleep(USE_POLL_MS, undefined, { signal });
  }
}

async function loadPasskeys(request: ChallengeRequest, ctx: ResolverContext): Promise<Passkey[]> {
  const cached = await cache(ctx).load(cacheKey(request, ctx));
  return cached === undefined ? [] : z.array(Passkey).parse(cached.credential);
}

function cache(ctx: ResolverContext): CredentialCache {
  return new CredentialCache(join(ctx.stateDir, "credentials"));
}

function cacheKey(request: ChallengeRequest, ctx: ResolverContext): CredentialKey {
  // the resolver stands where an auth strategy's name goes, so passkeys never share a file with a login's credential
  return { env: ctx.env.name, identity: request.identity, surface: playwrightDriver.surface, strategy: RESOLVER };
}
