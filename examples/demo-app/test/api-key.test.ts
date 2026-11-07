import { describe, expect, it } from "vite-plus/test"
import { DEMO_API_KEY } from "../src/config.ts"
import { Visitor } from "./support/demo.ts"

describe("/api/key/whoami", () => {
  it("answers 200 with the demo key in X-Api-Key", async () => {
    const response = await new Visitor().request("/api/key/whoami", { headers: { "X-Api-Key": DEMO_API_KEY } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ auth: "api-key" })
  })

  it("answers 401 to a wrong or missing key", async () => {
    const wrong = await new Visitor().request("/api/key/whoami", { headers: { "X-Api-Key": "other-key" } })
    const missing = await new Visitor().request("/api/key/whoami")

    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
  })
})
