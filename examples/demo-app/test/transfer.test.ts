import { describe, expect, it } from "vitest"
import { DEMO_PIN } from "../src/config.ts"
import { Visitor, newEmail, signInByEmail } from "./support/demo.ts"

describe("transfer PIN step", () => {
  it("confirms the transfer with the right PIN and counts it in /api/session/me", async () => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())

    const response = await visitor.postForm("/transfer/confirm", { pin: DEMO_PIN })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-testid="transfer-confirmed"')
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ transfersConfirmed: 1 })
  })

  it("refuses a wrong PIN with 401 and counts nothing", async () => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())

    const response = await visitor.postForm("/transfer/confirm", { pin: "0000" })

    expect(response.status).toBe(401)
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ transfersConfirmed: 0 })
  })

  it("sends a visitor without a session to /login", async () => {
    const response = await new Visitor().request("/transfer/confirm")

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login")
  })
})
