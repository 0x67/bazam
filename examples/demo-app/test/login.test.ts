import { describe, expect, it } from "vite-plus/test"
import { MAILPIT_URL, Visitor, mailedCode, newEmail } from "./support/demo.ts"

describe("email code sign-in", () => {
  it("mails a code through Mailpit that signs the user in", async () => {
    const visitor = new Visitor()
    const email = newEmail()

    const sent = await visitor.postForm("/login", { email })
    expect(sent.status).toBe(303)
    expect(sent.headers.get("location")).toBe(`/login/verify?email=${encodeURIComponent(email)}`)

    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    const { messages } = (await search.json()) as { messages: { Subject: string }[] }
    expect(messages[0]?.Subject).toBe("Your sign-in code")

    const verified = await visitor.postForm("/login/verify", { email, code: await mailedCode(email) })
    expect(verified.status).toBe(303)
    expect(verified.headers.get("location")).toBe("/dashboard")
    expect(visitor.cookie("session")).toBeTruthy()

    const dashboard = await visitor.request("/dashboard")
    expect(dashboard.status).toBe(200)
    const body = await dashboard.text()
    expect(body).toContain('data-testid="dashboard"')
    expect(body).toContain(email)
  })

  it("refuses a wrong code with 401 and no session", async () => {
    const visitor = new Visitor()
    const email = newEmail()
    await visitor.postForm("/login", { email })
    const wrong = String((Number(await mailedCode(email)) + 1) % 1_000_000).padStart(6, "0")

    const response = await visitor.postForm("/login/verify", { email, code: wrong })

    expect(response.status).toBe(401)
    expect(await response.text()).toContain('data-testid="error"')
    expect(visitor.cookie("session")).toBeUndefined()
  })

  it("accepts a code only once", async () => {
    const email = newEmail()
    await new Visitor().postForm("/login", { email })
    const code = await mailedCode(email)
    await new Visitor().postForm("/login/verify", { email, code })

    const replay = await new Visitor().postForm("/login/verify", { email, code })

    expect(replay.status).toBe(401)
  })

  it("answers 400 when the email field has no address", async () => {
    const response = await new Visitor().postForm("/login", { email: "not-an-address" })

    expect(response.status).toBe(400)
  })
})
