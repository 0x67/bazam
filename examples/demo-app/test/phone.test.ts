import { describe, expect, it } from "vite-plus/test"
import { Visitor, newEmail, signInByEmail } from "./support/demo.ts"

const CONTROL_WITHOUT_TEST_ID = /<(?:a|button|input|select|textarea)\b(?![^>]*data-testid=)[^>]*>/g

async function signedInVisitor(): Promise<Visitor> {
  const visitor = new Visitor()
  await signInByEmail(visitor, newEmail())
  return visitor
}

describe("phone pickers", () => {
  const entries: [string, Record<string, string>, string][] = [
    ["select", { country: "GB", number: "07700 900123" }, "+447700900123"],
    ["select", { country: "GB", number: "7700900123" }, "+447700900123"],
    ["select", { country: "US", number: "(202) 555-0123" }, "+12025550123"],
    ["search", { country: "\u{1F1EC}\u{1F1E7} +44", number: "07700900123" }, "+447700900123"],
    ["search", { country: "44", number: "7700 900123" }, "+447700900123"],
    ["full", { number: "+44 7700 900123" }, "+447700900123"],
    ["local", { number: "07700 900123" }, "+447700900123"],
  ]

  it.each(entries)("%s form saves %o as %s", async (picker, fields, e164) => {
    const visitor = await signedInVisitor()

    const response = await visitor.postForm(`/profile/phone/${picker}`, fields)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(`<output data-testid="${picker}-saved">${e164}</output>`)
  })

  it("keeps the number each form saved when the page loads again", async () => {
    const visitor = await signedInVisitor()
    await visitor.postForm("/profile/phone/full", { number: "+447700900123" })
    await visitor.postForm("/profile/phone/local", { number: "7700900123" })

    const page = await (await visitor.request("/profile/phone")).text()

    expect(page).toContain('<output data-testid="full-saved">+447700900123</output>')
    expect(page).toContain('<output data-testid="local-saved">+447700900123</output>')
    expect(page).not.toContain('data-testid="select-saved"')
  })

  it("refuses a full number without its country code with 400 and saves nothing", async () => {
    const visitor = await signedInVisitor()

    const response = await visitor.postForm("/profile/phone/full", { number: "07700900123" })
    const page = await response.text()

    expect(response.status).toBe(400)
    expect(page).toContain('data-testid="error"')
    expect(page).not.toContain('data-testid="full-saved"')
  })

  it("gives every control on the page a data-testid", async () => {
    const response = await (await signedInVisitor()).request("/profile/phone")

    expect(response.status).toBe(200)
    expect((await response.text()).match(CONTROL_WITHOUT_TEST_ID)).toBeNull()
  })

  it("sends a visitor without a session to /login", async () => {
    const response = await new Visitor().request("/profile/phone")

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login")
  })
})
