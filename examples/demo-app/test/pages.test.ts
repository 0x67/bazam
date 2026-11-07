import { describe, expect, it } from "vite-plus/test"
import { Visitor, newEmail, signInByEmail } from "./support/demo.ts"

const INTERACTIVE = /<(?:a|button|input|select|textarea)\b[^>]*>/g

function elementsWithoutTestId(html: string): string[] {
  return [...html.matchAll(INTERACTIVE)]
    .map(([tag]) => tag)
    .filter((tag) => !tag.includes('type="hidden"') && !tag.includes("data-testid="))
}

describe("pages", () => {
  const publicPages = ["/login", "/login/verify?email=someone%40example.test", "/login/totp"]
  const signedInPages = ["/dashboard", "/account/totp", "/account/passkey", "/transfer/confirm"]

  it.each(publicPages)("%s gives every interactive element a data-testid", async (path) => {
    const response = await new Visitor().request(path)

    expect(response.status).toBe(200)
    expect(elementsWithoutTestId(await response.text())).toEqual([])
  })

  it.each(signedInPages)("%s gives every interactive element a data-testid", async (path) => {
    const visitor = new Visitor()
    await signInByEmail(visitor, newEmail())

    const response = await visitor.request(path)

    expect(response.status).toBe(200)
    expect(elementsWithoutTestId(await response.text())).toEqual([])
  })

  it("serves the passkey script from public/", async () => {
    const response = await new Visitor().request("/passkey.js")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("javascript")
  })
})
