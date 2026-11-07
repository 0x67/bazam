import { describe, expect, it } from "vite-plus/test"
import { APP_URL, Visitor, newEmail, signInByEmail } from "./support/demo.ts"

describe("session cookie API", () => {
  it("answers 401 on /api/session/me without a session cookie", async () => {
    const response = await new Visitor().request("/api/session/me")

    expect(response.status).toBe(401)
  })

  it("replaces the session cookie on /auth/refresh and retires the old one", async () => {
    const visitor = new Visitor()
    const email = newEmail()
    await signInByEmail(visitor, email)
    const oldSession = visitor.cookie("session")

    const refreshed = await visitor.request("/auth/refresh", { method: "POST" })

    expect(refreshed.status).toBe(200)
    expect(visitor.cookie("session")).not.toBe(oldSession)
    expect(await (await visitor.request("/api/session/me")).json()).toMatchObject({ email })
    const stale = await fetch(new URL("/api/session/me", APP_URL), { headers: { Cookie: `session=${oldSession}` } })
    expect(stale.status).toBe(401)
  })

  it("answers 401 on /auth/refresh without a session", async () => {
    const response = await new Visitor().request("/auth/refresh", { method: "POST" })

    expect(response.status).toBe(401)
  })

  it("ends the session on /logout", async () => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())
    const session = visitor.cookie("session")

    const response = await visitor.request("/logout", { method: "POST" })

    expect(response.headers.get("location")).toBe("/login")
    const after = await fetch(new URL("/api/session/me", APP_URL), { headers: { Cookie: `session=${session}` } })
    expect(after.status).toBe(401)
  })
})
