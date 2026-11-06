import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server"
import { Hono, type Context } from "hono"
import { html } from "hono/html"
import type { DemoDeps } from "./deps.ts"
import { page } from "./layout.ts"
import { requireSignIn, sessionUser, startSession, type SignedIn } from "./session.ts"
import { deleteExpired, type Passkey, type Store } from "./store.ts"

const CHALLENGE_TTL_MS = 5 * 60_000

// the passkey page and the JSON endpoints public/passkey.js calls
export function passkeyRoutes(deps: DemoDeps): Hono<SignedIn> {
  const { store, config } = deps
  const rpID = config.origin.hostname
  const expectedOrigin = config.origin.origin
  const app = new Hono<SignedIn>()

  app.get("/account/passkey", requireSignIn(store), (c) =>
    c.html(accountPage(passkeysOf(store, c.get("user").email).length)))

  app.post("/account/passkey/options", async (c) => {
    const user = sessionUser(c, store)
    if (!user) return c.json({ error: "no session" }, 401)
    const options = await generateRegistrationOptions({
      rpName: "Demo app",
      rpID,
      userName: user.email,
      userID: user.webauthnUserId,
      excludeCredentials: passkeysOf(store, user.email).map(({ credential }) => ({ id: credential.id })),
    })
    store.registrationChallenges.set(user.email, options.challenge)
    return c.json(options)
  })

  app.post("/account/passkey", async (c) => {
    const user = sessionUser(c, store)
    if (!user) return c.json({ error: "no session" }, 401)
    const expectedChallenge = store.registrationChallenges.get(user.email)
    const response = await readJson<RegistrationResponseJSON>(c)
    if (!expectedChallenge || !response) return c.json({ error: "request registration options first" }, 400)
    store.registrationChallenges.delete(user.email)
    try {
      const result = await verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: false,
      })
      if (!result.verified) return c.json({ error: "registration was not verified" }, 400)
      const { credential } = result.registrationInfo
      store.passkeys.set(credential.id, { email: user.email, credential })
      return c.json({ verified: true })
    } catch (error) {
      return c.json({ error: messageOf(error) }, 400)
    }
  })

  // with an email, only that account's passkeys are allowed; without one the browser offers discoverable passkeys
  app.post("/login/passkey/options", async (c) => {
    const email = (await readJson<{ email?: string }>(c))?.email?.trim().toLowerCase() ?? ""
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeysOf(store, email).map(({ credential }) => ({ id: credential.id })),
    })
    const now = Date.now()
    deleteExpired(store.loginChallenges, now)
    store.loginChallenges.set(options.challenge, now + CHALLENGE_TTL_MS)
    return c.json(options)
  })

  app.post("/login/passkey", async (c) => {
    const response = await readJson<AuthenticationResponseJSON>(c)
    const passkey = response && store.passkeys.get(response.id)
    if (!response || !passkey) return c.json({ error: "unknown passkey" }, 400)
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => takeLoginChallenge(store, challenge),
        expectedOrigin,
        expectedRPID: rpID,
        credential: passkey.credential,
        requireUserVerification: false,
      })
      if (!result.verified) return c.json({ error: "sign-in was not verified" }, 400)
      passkey.credential.counter = result.authenticationInfo.newCounter
      startSession(c, deps, passkey.email)
      return c.json({ redirect: "/dashboard" })
    } catch (error) {
      return c.json({ error: messageOf(error) }, 400)
    }
  })

  return app
}

function passkeysOf(store: Store, email: string): Passkey[] {
  return [...store.passkeys.values()].filter((passkey) => passkey.email === email)
}

function takeLoginChallenge(store: Store, challenge: string): boolean {
  const expiresAt = store.loginChallenges.get(challenge)
  store.loginChallenges.delete(challenge)
  return expiresAt !== undefined && expiresAt > Date.now()
}

async function readJson<T>(c: Context): Promise<T | undefined> {
  try {
    return await c.req.json<T>()
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accountPage(count: number) {
  return page("Passkeys", html`
    <p>Passkeys on this account: <span data-testid="passkey-count">${count}</span></p>
    <p><button type="button" data-testid="register-passkey">Add a passkey</button></p>
    <p role="status" data-testid="passkey-status"></p>
    <p><a href="/dashboard" data-testid="back-to-dashboard">Back to dashboard</a></p>`)
}
