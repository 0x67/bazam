import { describe, expect, it } from "vite-plus/test"
import { DEMO_TOTP_SEED } from "../src/config.ts"
import { totpCode } from "../src/totp-code.ts"
import { Visitor, newEmail, signInByEmail } from "./support/demo.ts"

describe("totpCode", () => {
  it("matches the RFC 6238 SHA-1 vectors, last six digits", () => {
    expect(totpCode(DEMO_TOTP_SEED, 59_000)).toBe("287082")
    expect(totpCode(DEMO_TOTP_SEED, 1_111_111_109_000)).toBe("081804")
    expect(totpCode(DEMO_TOTP_SEED, 1_234_567_890_000)).toBe("005924")
    expect(totpCode(DEMO_TOTP_SEED, 2_000_000_000_000)).toBe("279037")
  })
})

describe("TOTP enrollment and sign-in", () => {
  async function enrolledUser(): Promise<string> {
    const visitor = new Visitor()
    const email = newEmail()
    await signInByEmail(visitor, email)
    await visitor.request("/account/totp")
    const enabled = await visitor.postForm("/account/totp", { code: totpCode(DEMO_TOTP_SEED, Date.now()) })
    if (enabled.status !== 303) throw new Error(`TOTP enrollment failed: ${enabled.status}`)
    return email
  }

  it("shows the fixed seed in test mode and turns TOTP on with a valid code", async () => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())

    const setup = await (await visitor.request("/account/totp")).text()
    expect(setup).toContain(`<code data-testid="totp-seed">${DEMO_TOTP_SEED}</code>`)

    const enabled = await visitor.postForm("/account/totp", { code: totpCode(DEMO_TOTP_SEED, Date.now()) })
    expect(enabled.status).toBe(303)
    expect(await (await visitor.request("/account/totp")).text()).toContain('data-testid="totp-enabled"')
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ totpEnabled: true })
  })

  it("refuses enrollment with a code from the wrong time window", async () => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())
    await visitor.request("/account/totp")

    const stale = totpCode(DEMO_TOTP_SEED, Date.now() - 10 * 60_000)
    const response = await visitor.postForm("/account/totp", { code: stale })

    expect(response.status).toBe(401)
  })

  it("signs in with the current code after enrollment", async () => {
    const email = await enrolledUser()
    const visitor = new Visitor()

    const response = await visitor.postForm("/login/totp", { email, code: totpCode(DEMO_TOTP_SEED, Date.now()) })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/dashboard")
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ email })
  })

  it("refuses TOTP sign-in for an account that never enrolled", async () => {
    const visitor = new Visitor()
    const email = newEmail()
    await signInByEmail(new Visitor(), email)

    const response = await visitor.postForm("/login/totp", { email, code: totpCode(DEMO_TOTP_SEED, Date.now()) })

    expect(response.status).toBe(401)
    expect(visitor.cookie("session")).toBeUndefined()
  })

  it("sends a visitor without a session from /account/totp to /login", async () => {
    const response = await new Visitor().request("/account/totp")

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login")
  })
})
