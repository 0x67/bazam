import { Hono } from "hono"
import type { DemoDeps } from "./deps.ts"

// mounted only when DEMO_TEST_HOOKS=1
export function testHookRoutes({ store }: DemoDeps): Hono {
  const app = new Hono()

  app.get("/test/otp", (c) => {
    const issued = store.otps.get(c.req.query("recipient")?.toLowerCase() ?? "")
    if (!issued) return c.json({ error: "no pending code for that recipient" }, 404)
    return c.json({ code: issued.code })
  })

  app.post("/test/reset", (c) => {
    store.reset()
    return c.body(null, 204)
  })

  return app
}
