import { describe, expect, it } from "vite-plus/test"
import { DEMO_OAUTH_CLIENT } from "../src/config.ts"
import { Visitor } from "./support/demo.ts"

interface TokenResponse { access_token: string; token_type: string; expires_in: number; refresh_token: string }

const clientBasic = {
  Authorization: `Basic ${Buffer.from(`${DEMO_OAUTH_CLIENT.id}:${DEMO_OAUTH_CLIENT.secret}`).toString("base64")}`,
}

async function token(fields: Record<string, string>, headers: Record<string, string> = clientBasic): Promise<Response> {
  return new Visitor().request("/oauth/token", { method: "POST", headers, body: new URLSearchParams(fields) })
}

function whoami(accessToken: string): Promise<Response> {
  return new Visitor().request("/api/oauth/whoami", { headers: { Authorization: `Bearer ${accessToken}` } })
}

describe("OAuth2 token endpoint", () => {
  it("issues a bearer token for client credentials over HTTP Basic that whoami accepts", async () => {
    const response = await token({ grant_type: "client_credentials" })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as TokenResponse
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 300 })
    const me = await whoami(body.access_token)
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ auth: "oauth2", clientId: DEMO_OAUTH_CLIENT.id })
  })

  it("accepts client credentials in the form body", async () => {
    const response = await token(
      { grant_type: "client_credentials", client_id: DEMO_OAUTH_CLIENT.id, client_secret: DEMO_OAUTH_CLIENT.secret },
      {},
    )

    expect(response.status).toBe(200)
  })

  it("swaps a refresh token for new tokens once", async () => {
    const first = (await (await token({ grant_type: "client_credentials" })).json()) as TokenResponse

    const refreshed = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })
    expect(refreshed.status).toBe(200)
    const second = (await refreshed.json()) as TokenResponse
    expect(second.access_token).not.toBe(first.access_token)
    expect((await whoami(second.access_token)).status).toBe(200)

    const reused = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })
    expect(reused.status).toBe(400)
    expect(await reused.json()).toEqual({ error: "invalid_grant" })
  })

  it("answers 401 invalid_client to a wrong client secret", async () => {
    const response = await token(
      { grant_type: "client_credentials" },
      { Authorization: `Basic ${Buffer.from(`${DEMO_OAUTH_CLIENT.id}:wrong`).toString("base64")}` },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "invalid_client" })
  })

  it("answers 401 on whoami for a token it never issued", async () => {
    const response = await whoami("not-a-token")

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("invalid_token")
  })
})
