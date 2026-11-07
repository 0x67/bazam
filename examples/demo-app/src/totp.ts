import { Hono } from "hono"
import { html } from "hono/html"
import { DEMO_TOTP_SEED } from "./config.ts"
import type { DemoDeps } from "./deps.ts"
import { formText } from "./form.ts"
import { errorMessage, page } from "./layout.ts"
import { requireSignIn, startSession, type SignedIn } from "./session.ts"
import { isValidTotp, newTotpSeed } from "./totp-code.ts"

export function totpRoutes(deps: DemoDeps): Hono<SignedIn> {
  const { store, config } = deps
  const app = new Hono<SignedIn>()

  app.get("/login/totp", (c) => c.html(signInPage()))

  app.post("/login/totp", async (c) => {
    const form = await c.req.parseBody()
    const email = formText(form, "email").toLowerCase()
    const seed = store.users.get(email)?.totpSeed
    if (!seed || !isValidTotp(seed, formText(form, "code"), Date.now())) {
      return c.html(signInPage("That code is wrong, or the account has no authenticator app."), 401)
    }
    startSession(c, deps, email)
    return c.redirect("/dashboard", 303)
  })

  app.use("/account/totp", requireSignIn(store))

  app.get("/account/totp", (c) => {
    const user = c.get("user")
    if (user.totpSeed) return c.html(enabledPage())
    user.pendingTotpSeed ??= config.testHooks ? DEMO_TOTP_SEED : newTotpSeed()
    return c.html(enrollPage(user.pendingTotpSeed))
  })

  app.post("/account/totp", async (c) => {
    const user = c.get("user")
    const seed = user.pendingTotpSeed
    if (!seed) return c.redirect("/account/totp", 303)
    if (!isValidTotp(seed, formText(await c.req.parseBody(), "code"), Date.now())) {
      return c.html(enrollPage(seed, "That code is wrong."), 401)
    }
    user.totpSeed = seed
    delete user.pendingTotpSeed
    return c.redirect("/account/totp", 303)
  })

  return app
}

function signInPage(error?: string) {
  return page(
    "Sign in with an authenticator app",
    html`
    ${errorMessage(error)}
    <form method="post" action="/login/totp">
      <label>Email <input type="email" name="email" autocomplete="username" required data-testid="email"></label>
      <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" required data-testid="totp-code"></label>
      <button type="submit" data-testid="sign-in-totp">Sign in</button>
    </form>
    <p><a href="/login" data-testid="back-to-login">Other ways to sign in</a></p>`,
  )
}

function enrollPage(seed: string, error?: string) {
  return page(
    "Set up an authenticator app",
    html`
    ${errorMessage(error)}
    <p>Add this key to your authenticator app: <code data-testid="totp-seed">${seed}</code></p>
    <form method="post" action="/account/totp">
      <label>Code from the app <input name="code" inputmode="numeric" autocomplete="one-time-code" required data-testid="totp-code"></label>
      <button type="submit" data-testid="enable-totp">Turn on</button>
    </form>
    <p><a href="/dashboard" data-testid="back-to-dashboard">Back to dashboard</a></p>`,
  )
}

function enabledPage() {
  return page(
    "Authenticator app",
    html`
    <p data-testid="totp-enabled">Your authenticator app is on.</p>
    <p><a href="/dashboard" data-testid="back-to-dashboard">Back to dashboard</a></p>`,
  )
}
