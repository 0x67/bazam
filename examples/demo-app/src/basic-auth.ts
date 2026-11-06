import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { DEMO_BASIC_USER } from "./config.ts"

export function basicAuthRoutes(): Hono {
  const app = new Hono()

  app.get("/api/basic/whoami", basicAuth(DEMO_BASIC_USER), (c) =>
    c.json({ auth: "basic", user: DEMO_BASIC_USER.username }))

  return app
}
