import { createHmac, randomBytes } from "node:crypto"

// RFC 6238 with HMAC-SHA1, 30 second steps and 6 digits
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const STEP_MS = 30_000
const DIGITS = 6

export function newTotpSeed(): string {
  return base32Encode(randomBytes(20))
}

export function totpCode(seed: string, nowMs: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / STEP_MS)))
  const mac = createHmac("sha1", base32Decode(seed)).update(counter).digest()
  const offset = mac.readUInt8(mac.length - 1) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0")
}

// one step either side absorbs clock drift between the app and the authenticator
export function isValidTotp(seed: string, code: string, nowMs: number): boolean {
  return [-STEP_MS, 0, STEP_MS].some((drift) => totpCode(seed, nowMs + drift) === code)
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31)
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31)
  return out
}

function base32Decode(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error(`invalid base32 character "${char}"`)
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
