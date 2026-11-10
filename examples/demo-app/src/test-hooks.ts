import { Hono } from "hono"
import type { DemoDeps } from "./deps.ts"
import { startSession } from "./session.ts"

// mounted only when DEMO_TEST_HOOKS=1
export function testHookRoutes(deps: DemoDeps): Hono {
  const { store } = deps
  const app = new Hono()

  app.get("/test/otp", (c) => {
    const issued = store.otps.get(c.req.query("recipient")?.toLowerCase() ?? "")
    if (!issued) return c.json({ error: "no pending code for that recipient" }, 404)
    return c.json({ code: issued.code })
  })

  // signs the address in without a code, for runs that need a session but do not test sign-in
  app.get("/test/login", (c) => {
    const email = c.req.query("email")?.toLowerCase() ?? ""
    if (!email.includes("@")) return c.json({ error: "email must be an email address" }, 400)
    store.findOrCreateUser(email)
    startSession(c, deps, email)
    return c.redirect("/dashboard", 303)
  })

  // ends only that user's sessions, so the other cases of a run stay signed in
  app.post("/test/expire-sessions", (c) => {
    const email = c.req.query("email")?.toLowerCase() ?? ""
    if (!email.includes("@")) return c.json({ error: "email must be an email address" }, 400)
    for (const [id, session] of store.sessions) if (session.email === email) store.sessions.delete(id)
    return c.body(null, 204)
  })

  app.post("/test/reset", (c) => {
    store.reset()
    return c.body(null, 204)
  })

  return app
}
