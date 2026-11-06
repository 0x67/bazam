import { Hono } from "hono"
import { DEMO_API_KEY } from "./config.ts"
import { safeEqual } from "./safe-equal.ts"

export function apiKeyRoutes(): Hono {
  const app = new Hono()

  app.get("/api/key/whoami", (c) => {
    if (!safeEqual(c.req.header("X-Api-Key") ?? "", DEMO_API_KEY)) {
      return c.json({ error: "missing or wrong X-Api-Key" }, 401)
    }
    return c.json({ auth: "api-key" })
  })

  return app
}
