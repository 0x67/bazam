import { Hono } from "hono"
import { html } from "hono/html"
import type { DemoDeps } from "./deps.ts"
import { page } from "./layout.ts"
import { requireSignIn, type SignedIn } from "./session.ts"

export function dashboardRoutes({ store }: DemoDeps): Hono<SignedIn> {
  const app = new Hono<SignedIn>()

  app.get("/", (c) => c.redirect("/dashboard", 303))

  app.get("/dashboard", requireSignIn(store), (c) =>
    c.html(
      page(
        "Dashboard",
        html`
    <section data-testid="dashboard">
      <p>Signed in as <strong data-testid="user-email">${c.get("user").email}</strong></p>
      <ul>
        <li><a href="/account/totp" data-testid="account-totp-link">Authenticator app</a></li>
        <li><a href="/account/passkey" data-testid="account-passkey-link">Passkeys</a></li>
        <li><a href="/transfer/confirm" data-testid="transfer-link">Send 25.00 to Savings</a></li>
        <li><a href="/profile/phone" data-testid="profile-phone-link">Phone number</a></li>
      </ul>
      <form method="post" action="/logout">
        <button type="submit" data-testid="sign-out">Sign out</button>
      </form>
    </section>`,
      ),
    ),
  )

  return app
}
