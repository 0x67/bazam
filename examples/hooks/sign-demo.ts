/// <reference types="node" />
import { createHash, createHmac, randomUUID } from "node:crypto";

// The demo's HMAC scheme written as a sign hook, the way a project signs for an API whose scheme the
// built-in template cannot express. Node strips the types when the run imports this file.

interface SignedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: Uint8Array;
}

interface HmacKey {
  keyId: string;
  secret: string;
}

/** The headers that sign `request` for the demo's /api/hmac/echo. */
export default function signDemo(request: SignedRequest, key: HmacKey): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const bodySha256 = createHash("sha256")
    .update(request.body ?? new Uint8Array())
    .digest("hex");
  const stringToSign = [
    request.method.toUpperCase(),
    request.url.pathname,
    request.url.search.slice(1),
    timestamp,
    nonce,
    bodySha256,
  ].join("\n");
  return {
    "X-Key-Id": key.keyId,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": createHmac("sha256", key.secret).update(stringToSign).digest("hex"),
  };
}
