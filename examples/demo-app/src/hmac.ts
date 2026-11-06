import { createHash, createHmac } from "node:crypto"
import { Hono } from "hono"
import { DEMO_HMAC_KEY } from "./config.ts"
import type { DemoDeps } from "./deps.ts"
import { safeEqual } from "./safe-equal.ts"
import { deleteExpired } from "./store.ts"

const MAX_SKEW_SECONDS = 30

interface SignedRequest {
  method: string
  path: string
  query: string // without the leading "?"
  body: Buffer
  // empty when the header is missing
  keyId: string
  timestamp: string // unix seconds
  nonce: string
  signature: string // lowercase hex
}

export function hmacRoutes({ store }: DemoDeps): Hono {
  const app = new Hono()

  app.all("/api/hmac/echo", async (c) => {
    const url = new URL(c.req.url)
    const request: SignedRequest = {
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      body: Buffer.from(await c.req.arrayBuffer()),
      keyId: c.req.header("X-Key-Id") ?? "",
      timestamp: c.req.header("X-Timestamp") ?? "",
      nonce: c.req.header("X-Nonce") ?? "",
      signature: c.req.header("X-Signature") ?? "",
    }
    const now = Date.now()
    const problem = signatureProblem(request, now)
    if (problem) return c.json({ error: problem }, 401)
    deleteExpired(store.hmacNonces, now)
    if (store.hmacNonces.has(request.nonce)) return c.json({ error: "nonce already used" }, 401)
    // kept until a replay would fail the timestamp check anyway
    store.hmacNonces.set(request.nonce, (Number(request.timestamp) + MAX_SKEW_SECONDS + 1) * 1000)
    return c.json({
      keyId: request.keyId,
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body.toString("utf8"),
    })
  })

  return app
}

function signatureProblem(request: SignedRequest, nowMs: number): string | undefined {
  const { keyId, timestamp, nonce, signature } = request
  if (!keyId || !timestamp || !nonce || !signature) return "X-Key-Id, X-Timestamp, X-Nonce and X-Signature are required"
  if (keyId !== DEMO_HMAC_KEY.id) return "unknown key id"
  if (!/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return `timestamp is more than ${MAX_SKEW_SECONDS} seconds from the server clock`
  }
  const stringToSign = [
    request.method,
    request.path,
    request.query,
    timestamp,
    nonce,
    createHash("sha256").update(request.body).digest("hex"),
  ].join("\n")
  const expected = createHmac("sha256", DEMO_HMAC_KEY.secret).update(stringToSign).digest("hex")
  return safeEqual(signature, expected) ? undefined : "signature does not match"
}
