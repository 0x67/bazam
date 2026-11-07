import { describe, expect, it } from "vite-plus/test"
import { DEMO_BASIC_USER } from "../src/config.ts"
import { Visitor } from "./support/demo.ts"

function basic(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

describe("/api/basic/whoami", () => {
  it("answers 200 with the demo user and password", async () => {
    const { username, password } = DEMO_BASIC_USER

    const response = await new Visitor().request("/api/basic/whoami", { headers: basic(username, password) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ auth: "basic", user: username })
  })

  it("answers 401 with a Basic challenge to a wrong password", async () => {
    const response = await new Visitor().request("/api/basic/whoami", { headers: basic(DEMO_BASIC_USER.username, "wrong") })

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic/)
  })
})
