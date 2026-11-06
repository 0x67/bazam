import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Visitor, mailedCode, newEmail, signInByEmail } from "./support/demo.ts"

describe("test hooks", () => {
  it("returns the pending code for a recipient, the same one Mailpit received", async () => {
    const email = newEmail()
    await new Visitor().postForm("/login", { email })

    const response = await new Visitor().request(`/test/otp?recipient=${encodeURIComponent(email)}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ code: await mailedCode(email) })
  })

  it("answers 404 when no code is pending for the recipient", async () => {
    const response = await new Visitor().request(`/test/otp?recipient=${encodeURIComponent(newEmail())}`)

    expect(response.status).toBe(404)
  })

  it("drops every session on reset", async () => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())

    const reset = await new Visitor().request("/test/reset", { method: "POST" })

    expect(reset.status).toBe(204)
    expect((await visitor.request("/api/session/me")).status).toBe(401)
  })

  it("are not mounted when DEMO_TEST_HOOKS is not 1", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0" }
    delete env.DEMO_TEST_HOOKS
    const app = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], { env })
    try {
      const [banner] = (await once(app.stdout, "data")) as [Buffer]
      const port = /listening on port (\d+)/.exec(banner.toString())?.[1]
      expect(banner.toString()).toContain("test hooks off")

      const otp = await fetch(`http://localhost:${port}/test/otp?recipient=${encodeURIComponent(newEmail())}`)
      const reset = await fetch(`http://localhost:${port}/test/reset`, { method: "POST" })

      expect(otp.status).toBe(404)
      expect(reset.status).toBe(404)
    } finally {
      app.kill()
    }
  })
})
