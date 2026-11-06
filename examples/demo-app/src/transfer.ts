import { Hono } from "hono"
import { html } from "hono/html"
import { DEMO_PIN } from "./config.ts"
import type { DemoDeps } from "./deps.ts"
import { formText } from "./form.ts"
import { errorMessage, page } from "./layout.ts"
import { safeEqual } from "./safe-equal.ts"
import { requireSignIn, type SignedIn } from "./session.ts"

// a human-only step: no mail or test hook carries the PIN
export function transferRoutes({ store }: DemoDeps): Hono<SignedIn> {
  const app = new Hono<SignedIn>()

  app.use("/transfer/confirm", requireSignIn(store))

  app.get("/transfer/confirm", (c) => c.html(confirmPage()))

  app.post("/transfer/confirm", async (c) => {
    if (!safeEqual(formText(await c.req.parseBody(), "pin"), DEMO_PIN)) {
      return c.html(confirmPage("That PIN is wrong."), 401)
    }
    c.get("user").transfersConfirmed += 1
    return c.html(page("Transfer confirmed", html`
      <p data-testid="transfer-confirmed">You sent 25.00 to Savings.</p>
      <p><a href="/dashboard" data-testid="back-to-dashboard">Back to dashboard</a></p>`))
  })

  return app
}

function confirmPage(error?: string) {
  return page("Confirm transfer", html`
    ${errorMessage(error)}
    <p data-testid="transfer-summary">Send 25.00 to Savings.</p>
    <form method="post" action="/transfer/confirm">
      <label>PIN <input type="password" name="pin" inputmode="numeric" autocomplete="off" required data-testid="pin-input"></label>
      <button type="submit" data-testid="confirm-transfer">Confirm</button>
    </form>
    <p><a href="/dashboard" data-testid="back-to-dashboard">Cancel</a></p>`)
}
