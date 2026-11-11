import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { DEMO_OAUTH_CLIENT } from "./config.ts"
import type { DemoDeps } from "./deps.ts"
import { formText } from "./form.ts"
import { safeEqual } from "./safe-equal.ts"
import type { Store } from "./store.ts"

const ACCESS_TOKEN_TTL_SECONDS = 300

// RFC 6749 token endpoint; client credentials also return a refresh token so the refresh grant can be exercised
export function oauthRoutes({ store }: DemoDeps): Hono {
  const app = new Hono()

  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store")
    const form = await c.req.parseBody()
    const client = clientCredentials(c.req.header("Authorization"), form)
    if (
      !safeEqual(client.id, DEMO_OAUTH_CLIENT.id) ||
      !safeEqual(client.secret, DEMO_OAUTH_CLIENT.secret)
    ) {
      c.header("WWW-Authenticate", 'Basic realm="oauth"')
      return c.json({ error: "invalid_client" }, 401)
    }
    const grantType = formText(form, "grant_type")
    if (grantType === "client_credentials") return c.json(issueTokens(store, client.id))
    if (grantType === "refresh_token") {
      const refreshToken = formText(form, "refresh_token")
      if (store.refreshTokens.get(refreshToken) !== client.id)
        return c.json({ error: "invalid_grant" }, 400)
      store.refreshTokens.delete(refreshToken)
      return c.json(issueTokens(store, client.id))
    }
    return c.json({ error: "unsupported_grant_type" }, 400)
  })

  app.get("/api/oauth/whoami", (c) => {
    const authorization = c.req.header("Authorization") ?? ""
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
    const issued = store.accessTokens.get(token)
    if (!issued || issued.expiresAt <= Date.now()) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"')
      return c.json({ error: "invalid_token" }, 401)
    }
    return c.json({ auth: "oauth2", clientId: issued.clientId })
  })

  return app
}

// HTTP Basic (client_secret_basic) or form fields (client_secret_post)
function clientCredentials(
  authorization: string | undefined,
  form: Record<string, unknown>,
): { id: string; secret: string } {
  if (authorization?.startsWith("Basic ")) {
    const [id = "", ...secret] = Buffer.from(authorization.slice("Basic ".length), "base64")
      .toString()
      .split(":")
    return { id, secret: secret.join(":") }
  }
  return { id: formText(form, "client_id"), secret: formText(form, "client_secret") }
}

function issueTokens(store: Store, clientId: string) {
  const accessToken = randomBytes(32).toString("base64url")
  const refreshToken = randomBytes(32).toString("base64url")
  store.accessTokens.set(accessToken, {
    clientId,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
  })
  store.refreshTokens.set(refreshToken, clientId)
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
  }
}
