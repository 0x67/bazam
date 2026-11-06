import { randomBytes } from "node:crypto"
import type { WebAuthnCredential } from "@simplewebauthn/server"

export interface User {
  email: string
  webauthnUserId: Uint8Array<ArrayBuffer>
  totpSeed?: string
  pendingTotpSeed?: string
  transfersConfirmed: number
}

export interface IssuedOtp { code: string; expiresAt: number }
export interface Session { email: string; expiresAt: number }
export interface AccessToken { clientId: string; expiresAt: number }
export interface Passkey { email: string; credential: WebAuthnCredential }

export class Store {
  readonly users = new Map<string, User>()
  readonly otps = new Map<string, IssuedOtp>() // by email, latest only
  readonly sessions = new Map<string, Session>()
  readonly accessTokens = new Map<string, AccessToken>()
  readonly refreshTokens = new Map<string, string>() // token to client id
  readonly passkeys = new Map<string, Passkey>() // by credential id
  readonly registrationChallenges = new Map<string, string>() // email to challenge
  readonly loginChallenges = new Map<string, number>() // challenge to expiry
  readonly hmacNonces = new Map<string, number>() // nonce to expiry

  findOrCreateUser(email: string): User {
    let user = this.users.get(email)
    if (!user) {
      user = { email, webauthnUserId: new Uint8Array(randomBytes(16)), transfersConfirmed: 0 }
      this.users.set(email, user)
    }
    return user
  }

  reset(): void {
    for (const map of [
      this.users, this.otps, this.sessions, this.accessTokens, this.refreshTokens,
      this.passkeys, this.registrationChallenges, this.loginChallenges, this.hmacNonces,
    ]) map.clear()
  }
}

// for maps from a one-time value to its expiry in epoch milliseconds
export function deleteExpired(map: Map<string, number>, nowMs: number): void {
  for (const [key, expiresAt] of map) if (expiresAt <= nowMs) map.delete(key)
}
