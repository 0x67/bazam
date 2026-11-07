import { createHash, createHmac, randomUUID } from "node:crypto"
import { describe, expect, it } from "vite-plus/test"
import { DEMO_HMAC_KEY } from "../src/config.ts"
import { Visitor } from "./support/demo.ts"

interface Signing {
  method: string
  pathAndQuery: string
  body: string
  timestamp?: number
  nonce?: string
}

// built from the format in README.md, independent of the server code
function signedHeaders({
  method,
  pathAndQuery,
  body,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomUUID(),
}: Signing) {
  const [path = "", query = ""] = pathAndQuery.split("?")
  const bodySha256 = createHash("sha256").update(body).digest("hex")
  const stringToSign = `${method}\n${path}\n${query}\n${timestamp}\n${nonce}\n${bodySha256}`
  return {
    "X-Key-Id": DEMO_HMAC_KEY.id,
    "X-Timestamp": String(timestamp),
    "X-Nonce": nonce,
    "X-Signature": createHmac("sha256", DEMO_HMAC_KEY.secret).update(stringToSign).digest("hex"),
  }
}

function send(signing: Signing, body = signing.body): Promise<Response> {
  return new Visitor().request(signing.pathAndQuery, {
    method: signing.method,
    headers: { ...signedHeaders(signing), "Content-Type": "application/json" },
    body,
  })
}

describe("/api/hmac/echo", () => {
  const order = { method: "POST", pathAndQuery: "/api/hmac/echo?side=buy&qty=2", body: '{"symbol":"DEMO"}' }

  it("echoes a request signed with the documented string to sign", async () => {
    const response = await send(order)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      keyId: DEMO_HMAC_KEY.id,
      method: "POST",
      path: "/api/hmac/echo",
      query: "side=buy&qty=2",
      body: '{"symbol":"DEMO"}',
    })
  })

  it("refuses a body that differs from the signed one", async () => {
    const response = await send(order, '{"symbol":"OTHER"}')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "signature does not match" })
  })

  it("refuses a timestamp more than 30 seconds off", async () => {
    const response = await send({ ...order, timestamp: Math.floor(Date.now() / 1000) - 31 })

    expect(response.status).toBe(401)
  })

  it("refuses a nonce it has already seen", async () => {
    const signing = { ...order, nonce: randomUUID(), timestamp: Math.floor(Date.now() / 1000) }
    await send(signing)

    const replay = await send(signing)

    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: "nonce already used" })
  })
})
