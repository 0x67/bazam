import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { apiKeyRoutes } from "./api-key.ts"
import { basicAuthRoutes } from "./basic-auth.ts"
import { loadConfig } from "./config.ts"
import { dashboardRoutes } from "./dashboard.ts"
import type { DemoDeps } from "./deps.ts"
import { hmacRoutes } from "./hmac.ts"
import { loginRoutes } from "./login.ts"
import { smtpOtpSender } from "./mail.ts"
import { oauthRoutes } from "./oauth.ts"
import { passkeyRoutes } from "./passkey.ts"
import { phoneRoutes } from "./phone.ts"
import { sessionRoutes } from "./session.ts"
import { Store } from "./store.ts"
import { testHookRoutes } from "./test-hooks.ts"
import { totpRoutes } from "./totp.ts"
import { transferRoutes } from "./transfer.ts"

const config = loadConfig(process.env)
const deps: DemoDeps = { config, store: new Store(), sendOtp: smtpOtpSender(config.smtp) }

const app = new Hono()
app.route("/", dashboardRoutes(deps))
app.route("/", loginRoutes(deps))
app.route("/", totpRoutes(deps))
app.route("/", passkeyRoutes(deps))
app.route("/", transferRoutes(deps))
app.route("/", phoneRoutes(deps))
app.route("/", sessionRoutes(deps))
app.route("/", apiKeyRoutes())
app.route("/", basicAuthRoutes())
app.route("/", oauthRoutes(deps))
app.route("/", hmacRoutes(deps))
if (config.testHooks) app.route("/", testHookRoutes(deps))
app.use("/*", serveStatic({ root: fileURLToPath(new URL("../public", import.meta.url)) }))

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `demo app listening on port ${info.port} for ${config.origin.origin}, test hooks ${config.testHooks ? "on" : "off"}`,
  )
})
