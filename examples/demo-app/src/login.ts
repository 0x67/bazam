import { randomInt } from "node:crypto"
import { Hono } from "hono"
import { html } from "hono/html"
import type { DemoDeps } from "./deps.ts"
import { formText } from "./form.ts"
import { errorMessage, page } from "./layout.ts"
import { startSession } from "./session.ts"

const OTP_TTL_MS = 5 * 60_000

// the sign-in page and the email code flow; passkey and TOTP sign-in live in passkey.ts and totp.ts
export function loginRoutes(deps: DemoDeps): Hono {
  const { store, sendOtp } = deps
  const app = new Hono()

  app.get("/login", (c) => c.html(loginPage()))

  app.post("/login", async (c) => {
    const email = formText(await c.req.parseBody(), "email").toLowerCase()
    if (!email.includes("@")) return c.html(loginPage("Enter an email address."), 400)
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
    store.otps.set(email, { code, expiresAt: Date.now() + OTP_TTL_MS })
    await sendOtp(email, code)
    return c.redirect(`/login/verify?email=${encodeURIComponent(email)}`, 303)
  })

  app.get("/login/verify", (c) => c.html(verifyPage(c.req.query("email") ?? "")))

  app.post("/login/verify", async (c) => {
    const form = await c.req.parseBody()
    const email = formText(form, "email").toLowerCase()
    const issued = store.otps.get(email)
    if (!issued || issued.expiresAt <= Date.now() || issued.code !== formText(form, "code")) {
      return c.html(verifyPage(email, "That code is wrong or has expired."), 401)
    }
    store.otps.delete(email)
    store.findOrCreateUser(email)
    startSession(c, deps, email)
    return c.redirect("/dashboard", 303)
  })

  return app
}

function loginPage(error?: string) {
  return page(
    "Sign in",
    html`
    ${errorMessage(error)}
    <form method="post" action="/login">
      <label>Email <input type="email" name="email" autocomplete="username webauthn" required data-testid="email"></label>
      <button type="submit" data-testid="send-code">Email me a code</button>
    </form>
    <p><button type="button" data-testid="sign-in-passkey">Sign in with a passkey</button></p>
    <p role="status" data-testid="passkey-status"></p>
    <p><a href="/login/totp" data-testid="sign-in-totp-link">Sign in with an authenticator app</a></p>`,
  )
}

function verifyPage(email: string, error?: string) {
  return page(
    "Enter your code",
    html`
    ${errorMessage(error)}
    <p>We sent a code to <span data-testid="code-recipient">${email}</span>.</p>
    <form method="post" action="/login/verify">
      <input type="hidden" name="email" value="${email}">
      <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" required data-testid="otp-input"></label>
      <button type="submit" data-testid="verify-code">Sign in</button>
    </form>
    <p><a href="/login" data-testid="back-to-login">Use another email</a></p>`,
  )
}
