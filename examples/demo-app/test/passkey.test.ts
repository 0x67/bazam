import { describe, expect, it } from "vite-plus/test"
import { SoftwareAuthenticator } from "./support/authenticator.ts"
import { APP_URL, Visitor, newEmail, signInByEmail } from "./support/demo.ts"

interface LoginOptions {
  challenge: string
  rpId: string
  allowCredentials: { id: string }[]
}

async function registeredPasskey(): Promise<{ email: string; authenticator: SoftwareAuthenticator }> {
  const visitor = new Visitor()
  const email = newEmail()
  await signInByEmail(visitor, email)
  const authenticator = new SoftwareAuthenticator(APP_URL)
  const options = await (await visitor.postJson("/account/passkey/options", {})).json()
  const registered = await visitor.postJson("/account/passkey", authenticator.register(options))
  if (registered.status !== 200) throw new Error(`registration failed: ${await registered.text()}`)
  return { email, authenticator }
}

describe("passkeys", () => {
  it("registers a passkey that then signs the user in", async () => {
    const { email, authenticator } = await registeredPasskey()
    const visitor = new Visitor()

    const options = (await (await visitor.postJson("/login/passkey/options", { email })).json()) as LoginOptions
    expect(options.allowCredentials.map(({ id }) => id)).toEqual([authenticator.credentialId.toString("base64url")])

    const response = await visitor.postJson("/login/passkey", authenticator.assert(options))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ redirect: "/dashboard" })
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ email, passkeys: 1 })
  })

  it("leaves allowCredentials empty without an email so a discoverable passkey can sign in", async () => {
    const { email, authenticator } = await registeredPasskey()
    const visitor = new Visitor()

    const options = (await (await visitor.postJson("/login/passkey/options", {})).json()) as LoginOptions
    expect(options.allowCredentials).toEqual([])

    const response = await visitor.postJson("/login/passkey", authenticator.assert(options))

    expect(response.status).toBe(200)
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ email })
  })

  it("refuses a replayed sign-in response", async () => {
    const { email, authenticator } = await registeredPasskey()
    const visitor = new Visitor()
    const options = (await (await visitor.postJson("/login/passkey/options", { email })).json()) as LoginOptions
    const assertion = authenticator.assert(options)
    await visitor.postJson("/login/passkey", assertion)

    const replay = await new Visitor().postJson("/login/passkey", assertion)

    expect(replay.status).toBe(400)
  })

  it("answers 401 to registration options without a session", async () => {
    const response = await new Visitor().postJson("/account/passkey/options", {})

    expect(response.status).toBe(401)
  })
})
