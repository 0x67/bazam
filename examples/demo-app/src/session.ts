import { randomBytes } from "node:crypto"
import { Hono, type Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import type { DemoDeps } from "./deps.ts"
import type { Session, Store, User } from "./store.ts"

const SESSION_COOKIE = "session"
const SESSION_TTL_MS = 10 * 60_000

export type SignedIn = { Variables: { user: User } }

// returns the expiry in epoch milliseconds
export function startSession(c: Context, { store, config }: DemoDeps, email: string): number {
  const id = randomBytes(32).toString("base64url")
  const expiresAt = Date.now() + SESSION_TTL_MS
  store.sessions.set(id, { email, expiresAt })
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: config.origin.protocol === "https:",
    maxAge: SESSION_TTL_MS / 1000,
  })
  return expiresAt
}

export function sessionUser(c: Context, store: Store): User | undefined {
  const session = liveSession(c, store)
  return session && store.users.get(session.email)
}

export function requireSignIn(store: Store) {
  return createMiddleware<SignedIn>(async (c, next) => {
    const user = sessionUser(c, store)
    if (!user) return c.redirect("/login", 303)
    c.set("user", user)
    await next()
  })
}

export function sessionRoutes(deps: DemoDeps): Hono {
  const { store } = deps
  const app = new Hono()

  app.get("/api/session/me", (c) => {
    const user = sessionUser(c, store)
    if (!user) return c.json({ error: "no session" }, 401)
    const passkeys = [...store.passkeys.values()].filter(
      (passkey) => passkey.email === user.email,
    ).length
    return c.json({
      email: user.email,
      totpEnabled: user.totpSeed !== undefined,
      passkeys,
      transfersConfirmed: user.transfersConfirmed,
    })
  })

  // replaces the session id and extends the expiry
  app.post("/auth/refresh", (c) => {
    const session = liveSession(c, store)
    if (!session) return c.json({ error: "no session" }, 401)
    store.sessions.delete(getCookie(c, SESSION_COOKIE) ?? "")
    const expiresAt = startSession(c, deps, session.email)
    return c.json({ expiresAt: new Date(expiresAt).toISOString() })
  })

  app.post("/logout", (c) => {
    store.sessions.delete(getCookie(c, SESSION_COOKIE) ?? "")
    deleteCookie(c, SESSION_COOKIE, { path: "/" })
    return c.redirect("/login", 303)
  })

  return app
}

function liveSession(c: Context, store: Store): Session | undefined {
  const session = store.sessions.get(getCookie(c, SESSION_COOKIE) ?? "")
  return session && session.expiresAt > Date.now() ? session : undefined
}
